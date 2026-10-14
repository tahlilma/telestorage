import "server-only";
import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

/** Seconds of per-second history kept for dashboard charts. */
export const HISTORY_SECONDS = 300;

/** Fixed-size reservoir of recent samples; percentiles computed on demand. */
export class LatencyHistogram {
  private samples: Float64Array;
  private cursor = 0;
  private filled = 0;
  count = 0;
  sum = 0;
  max = 0;

  constructor(size = 2048) {
    this.samples = new Float64Array(size);
  }

  record(ms: number) {
    this.samples[this.cursor] = ms;
    this.cursor = (this.cursor + 1) % this.samples.length;
    this.filled = Math.min(this.filled + 1, this.samples.length);
    this.count++;
    this.sum += ms;
    if (ms > this.max) this.max = ms;
  }

  /** Times an async operation, recording its duration whether it resolves or rejects. */
  async time<T>(fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      this.record(performance.now() - start);
    }
  }

  snapshot() {
    if (this.filled === 0) return { count: this.count, p50: 0, p90: 0, p99: 0, max: 0, mean: 0 };
    const sorted = Array.from(this.samples.subarray(0, this.filled)).sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    return {
      count: this.count,
      p50: at(0.5),
      p90: at(0.9),
      p99: at(0.99),
      max: sorted[sorted.length - 1],
      mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    };
  }
}

/** Ring buffer of numbers, one slot per second. */
class Series {
  readonly values = new Float64Array(HISTORY_SECONDS);
  private head = 0;
  push(v: number) {
    this.values[this.head] = v;
    this.head = (this.head + 1) % HISTORY_SECONDS;
  }
  /** Oldest → newest. */
  toArray(): number[] {
    const out = new Array<number>(HISTORY_SECONDS);
    for (let i = 0; i < HISTORY_SECONDS; i++) out[i] = this.values[(this.head + i) % HISTORY_SECONDS];
    return out;
  }
  last(): number {
    return this.values[(this.head - 1 + HISTORY_SECONDS) % HISTORY_SECONDS];
  }
}

export type LogLevel = "info" | "warn" | "error";
export interface LogEntry {
  ts: number;
  level: LogLevel;
  scope: string;
  msg: string;
}

const COUNTER_NAMES = [
  "tg.bytesUp",
  "tg.bytesDown",
  "http.bytesIn",
  "http.bytesOut",
  "tg.requests",
  "tg.errors",
  "tg.floodWaits",
  "tg.floodWaitSeconds",
  "tg.fileRefRefresh",
  "cache.memHits",
  "cache.diskHits",
  "cache.misses",
  "cache.coalesced",
  "uploads.completed",
  "uploads.deduped",
  "uploads.identical",
  "uploads.renamed",
  "uploads.replaced",
  "uploads.skipped",
  "uploads.dedupedAtCompletion",
  "shares.views",
  "shares.downloads",
  "shares.unlockFailures",
  "requests.received",
  "uploads.bytesDeduped",
  "http.requests",
  "gc.partsDeleted",
  "gc.kicks",
  "lb.failovers",
  "lb.hedges",
  "lb.hedgeWins",
  "upload.chunks",
  "upload.digestMismatches",
  "upload.windowMismatches",
  "upload.partsRedone",
  "upload.piecesResent",
  "admission.rejected",
  "idempotency.replays",
  "integrity.blocksVerified",
  "integrity.mismatches",
  "integrity.refetches",
  "integrity.cacheEvictions",
  "integrity.filesVerified",
  "integrity.fileMismatches",
  "scrub.bytes",
  "events.emitted",
  "trash.autoPurged",
  "fsck.repairs",
  "backup.stored",
  "backup.thumbPacks",
  "backup.thumbPacksLoaded",
] as const;
export type CounterName = (typeof COUNTER_NAMES)[number];

const SERIES_NAMES = [
  "tgUp", // bytes/s to Telegram
  "tgDown", // bytes/s from Telegram
  "served", // bytes/s to HTTP clients
  "received", // bytes/s from HTTP clients
  "cacheHitRatio", // 0..1 over the last second (NaN-free: -1 when idle)
  "tgRps", // Telegram RPCs/s
  "loopLagMs", // event-loop delay p99
  "rssMb",
  "heapMb",
  "cpuPct",
  "activeStreams",
] as const;
export type SeriesName = (typeof SERIES_NAMES)[number];

class Metrics {
  readonly startedAt = Date.now();
  readonly counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0])) as Record<CounterName, number>;
  readonly series = Object.fromEntries(SERIES_NAMES.map((n) => [n, new Series()])) as Record<SeriesName, Series>;
  readonly latency = {
    tgGetFile: new LatencyHistogram(),
    tgSavePart: new LatencyHistogram(),
    tgSendMedia: new LatencyHistogram(),
    tgGetMessages: new LatencyHistogram(),
    timeToFirstByte: new LatencyHistogram(),
    apiList: new LatencyHistogram(),
  };
  readonly errorsByCode = new Map<string, number>();
  readonly logs: LogEntry[] = [];
  /** Last time a user-facing transfer happened (background jobs yield to it). */
  lastForegroundAt = 0;
  gauges = { activeStreams: 0, activeUploads: 0, inflightBlocks: 0, liveClients: 0, admissionBytes: 0, admissionQueued: 0 };

  private prev = { ...this.counters };
  private prevCpu = process.cpuUsage();
  private prevTick = performance.now();
  private loop: IntervalHistogram;
  private timer: NodeJS.Timeout;
  private listeners = new Set<() => void>();

  constructor() {
    // Hit ratio uses -1 for "no lookups"; history before boot is no data, not 0 %.
    this.series.cacheHitRatio.values.fill(-1);
    this.loop = monitorEventLoopDelay({ resolution: 10 });
    this.loop.enable();
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
  }

  inc(name: CounterName, by = 1) {
    this.counters[name] += by;
  }

  error(code: string) {
    this.counters["tg.errors"]++;
    this.errorsByCode.set(code, (this.errorsByCode.get(code) ?? 0) + 1);
  }

  log(level: LogLevel, scope: string, msg: string) {
    this.logs.push({ ts: Date.now(), level, scope, msg });
    if (this.logs.length > 300) this.logs.splice(0, this.logs.length - 300);
    const line = `[telestorage:${scope}] ${msg}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }

  /** Subscribe to the 1 Hz tick (used by the dashboard's SSE stream). */
  onTick(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private delta(name: CounterName) {
    return this.counters[name] - this.prev[name];
  }

  private tick() {
    const now = performance.now();
    const secs = Math.max(0.001, (now - this.prevTick) / 1000);
    this.prevTick = now;

    this.series.tgUp.push(this.delta("tg.bytesUp") / secs);
    this.series.tgDown.push(this.delta("tg.bytesDown") / secs);
    this.series.served.push(this.delta("http.bytesOut") / secs);
    this.series.received.push(this.delta("http.bytesIn") / secs);
    this.series.tgRps.push(this.delta("tg.requests") / secs);

    const hits = this.delta("cache.memHits") + this.delta("cache.diskHits");
    const total = hits + this.delta("cache.misses");
    this.series.cacheHitRatio.push(total ? hits / total : -1);

    this.series.loopLagMs.push(this.loop.percentile(99) / 1e6);
    this.loop.reset();

    const mem = process.memoryUsage();
    this.series.rssMb.push(mem.rss / 1048576);
    this.series.heapMb.push(mem.heapUsed / 1048576);

    const cpu = process.cpuUsage(this.prevCpu);
    this.prevCpu = process.cpuUsage();
    this.series.cpuPct.push(((cpu.user + cpu.system) / 1000 / (secs * 1000)) * 100);
    this.series.activeStreams.push(this.gauges.activeStreams);

    this.prev = { ...this.counters };
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        /* listener errors must never break the ticker */
      }
    }
  }

  seriesSnapshot() {
    return Object.fromEntries(SERIES_NAMES.map((n) => [n, this.series[n].toArray()])) as Record<SeriesName, number[]>;
  }

  latestSample() {
    return Object.fromEntries(SERIES_NAMES.map((n) => [n, this.series[n].last()])) as Record<SeriesName, number>;
  }

  latencySnapshot() {
    return Object.fromEntries(Object.entries(this.latency).map(([k, h]) => [k, h.snapshot()]));
  }
}

const g = globalThis as unknown as { __tsMetrics?: Metrics };
export const metrics: Metrics = (g.__tsMetrics ??= new Metrics());
export const log = {
  info: (scope: string, msg: string) => metrics.log("info", scope, msg),
  warn: (scope: string, msg: string) => metrics.log("warn", scope, msg),
  error: (scope: string, msg: string) => metrics.log("error", scope, msg),
};
