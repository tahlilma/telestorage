import "server-only";
import crypto from "node:crypto";
import type { BotStatus, EndpointStatus } from "@/lib/types";
import {
  Background,
  CircuitBreaker,
  HedgeBudget,
  Interactive,
  LatencyWindow,
  Normal,
  PeakEwma,
  PriorityGate,
  PriorityToken,
  TokenBucket,
  pickP2C,
  type Balanceable,
  type Priority,
} from "../lb";
import { log, metrics, type LatencyHistogram } from "../metrics";
import { sleep } from "../sem";
import {
  FloodWaitError,
  GoneError,
  IntegrityError,
  TransientError,
  UnavailableError,
  type ChannelPost,
  type DriverName,
  type DriverStatus,
  type IoContext,
  type PartInfo,
  type PartUploadState,
  type StorageDriver,
} from "./types";

/**
 * One storage account (a Telegram bot, or a simulated one) with N independent
 * connections. Transports do exactly one attempt per call and translate their
 * native errors into FloodWaitError / TransientError / GoneError; every retry,
 * failover and pacing decision lives in the pool below.
 */
export interface Transport {
  readonly id: string;
  readonly connections: number;
  label: string;
  dcId: number;
  start(): Promise<void>;
  stop(): Promise<void>;
  connected(conn: number): boolean;
  uploadPiece(conn: number, fileId: string, piece: number, totalPieces: number, big: boolean, bytes: Buffer): Promise<void>;
  commit(conn: number, fileId: string, totalPieces: number, big: boolean, fileName: string, caption: string): Promise<string>;
  readBlock(conn: number, ref: string, offset: number, length: number): Promise<Buffer>;
  deleteRefs(conn: number, refs: string[]): Promise<void>;
  pin?(conn: number, ref: string): Promise<void>;
  pinnedPost?(conn: number): Promise<ChannelPost | null>;
  editCaption?(conn: number, ref: string, caption: string): Promise<void>;
  /** Current session string (Telegram), so it can be handed to the next server. */
  session?(): string | null;
  readonly token?: string;
  channel?(): { id: string; title: string | null } | null;
}

export interface PoolOptions {
  perConnectionConcurrency: number;
  /** sendMedia budget per bot (Telegram allows ~20 messages/minute per chat for bots). */
  commitsPerMinute: number;
  commitBurst: number;
  /** Duplicate slow interactive reads on a second bot (tail-latency hedging). */
  hedging: boolean;
}

/** Telegram requires saveBigFilePart for files above 10 MB. */
const BIG_FILE_THRESHOLD = 10 * 1024 * 1024;

const errorCode = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 120);

class Endpoint {
  readonly key: string;
  readonly gate: PriorityGate;
  readonly readLatency = new PeakEwma(10_000, 150);
  readonly writeLatency = new PeakEwma(10_000, 150);
  readonly breaker = new CircuitBreaker(4, 8_000);
  readonly forRead: Balanceable;
  readonly forWrite: Balanceable;

  constructor(
    readonly member: Member,
    readonly conn: number,
    concurrency: number,
  ) {
    this.key = `${member.transport.id}:${conn}`;
    this.gate = new PriorityGate(concurrency);
    const base = {
      key: this.key,
      capacity: concurrency,
      load: () => this.gate.load,
      eligible: () => this.usable(),
    };
    this.forRead = { ...base, latency: () => this.readLatency.get() };
    this.forWrite = { ...base, latency: () => this.writeLatency.get() };
  }

  usable() {
    return this.member.ready && !this.member.flooded && this.breaker.canAttempt() && this.member.transport.connected(this.conn);
  }

  status(): EndpointStatus {
    return {
      conn: this.conn,
      connected: this.member.transport.connected(this.conn),
      active: this.gate.active,
      queued: this.gate.pending,
      readLatencyMs: Math.round(this.readLatency.get()),
      writeLatencyMs: Math.round(this.writeLatency.get()),
      breaker: this.breaker.state,
      served: [...this.gate.served] as [number, number, number],
    };
  }
}

class Member {
  state: BotStatus["state"] = "connecting";
  floodUntil = 0;
  /** Upload file ids currently pinned to this bot. */
  readonly assigned = new Set<string>();
  readonly endpoints: Endpoint[];
  readonly commitBucket: TokenBucket;
  readonly asBalanceable: Balanceable;
  readonly stats = { requests: 0, bytesUp: 0, bytesDown: 0, errors: 0, lastError: null as string | null, lastErrorAt: null as number | null };

  constructor(
    readonly index: number,
    readonly transport: Transport,
    opts: PoolOptions,
  ) {
    this.endpoints = Array.from({ length: transport.connections }, (_, c) => new Endpoint(this, c, opts.perConnectionConcurrency));
    this.commitBucket = new TokenBucket(opts.commitsPerMinute / 60, opts.commitBurst);
    this.asBalanceable = {
      key: transport.id,
      capacity: transport.connections * opts.perConnectionConcurrency,
      // Parts pinned to a bot are long-lived work; weigh them heavily.
      load: () => this.assigned.size * 16 + this.endpoints.reduce((n, e) => n + e.gate.load, 0),
      latency: () => this.endpoints.reduce((n, e) => n + e.writeLatency.get(), 0) / Math.max(1, this.endpoints.length),
      eligible: () => this.ready && !this.flooded,
    };
  }

  get ready() {
    return this.state === "ready";
  }

  get flooded() {
    return this.floodUntil > Date.now();
  }
}

/** Hedges per read at most: primary + two more bots. */
const MAX_HEDGES = 2;

export class PoolDriver implements StorageDriver {
  readonly cacheable = true;
  private members: Member[] = [];
  private readonly hedges = new HedgeBudget(0.1, 3);
  /** Pool-wide read service times: the hedge trigger (per-endpoint peak-EWMA drives balancing). */
  private readonly readWindow = new LatencyWindow(256);
  private readonly timers = new Set<NodeJS.Timeout>();
  private stopped = false;

  constructor(
    readonly name: DriverName,
    private readonly transports: Transport[],
    private readonly opts: PoolOptions,
  ) {}

  // ---- lifecycle -----------------------------------------------------------

  async init() {
    this.members = this.transports.map((t, i) => new Member(i, t, this.opts));
    const results = await Promise.allSettled(this.members.map((m) => this.startMember(m)));
    if (!results.some((r) => r.status === "fulfilled")) {
      await this.stop();
      const reasons = results.map((r) => (r.status === "rejected" ? errorCode(r.reason) : "ok")).join("; ");
      throw new Error(`No ${this.name} bot could connect: ${reasons}`);
    }
    results.forEach((r, i) => {
      if (r.status === "rejected") this.scheduleRestart(this.members[i], r.reason, 0);
    });
  }

  private async startMember(m: Member) {
    m.state = "connecting";
    await m.transport.start();
    m.state = "ready";
    log.info(this.name, `${m.transport.label} ready (DC${m.transport.dcId}, ${m.transport.connections} connections)`);
  }

  /** Background reconnect with exponential backoff; the pool keeps serving on the remaining bots. */
  private scheduleRestart(m: Member, reason: unknown, attempt: number) {
    m.state = "error";
    this.noteError(m, null, reason);
    log.error(this.name, `${m.transport.label || m.transport.id} unavailable: ${errorCode(reason)}`);
    if (this.stopped) return;
    const delay = Math.min(10 * 60_000, 15_000 * 2 ** attempt);
    const t = setTimeout(async () => {
      this.timers.delete(t);
      if (this.stopped) return;
      try {
        await m.transport.stop().catch(() => {});
        await this.startMember(m);
      } catch (e) {
        this.scheduleRestart(m, e, attempt + 1);
      }
    }, delay);
    t.unref();
    this.timers.add(t);
  }

  async stop() {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    await Promise.all(this.members.map((m) => m.transport.stop().catch(() => {})));
  }

  // ---- plumbing ------------------------------------------------------------

  private noteError(m: Member, ep: Endpoint | null, e: unknown) {
    const code = errorCode(e);
    m.stats.errors++;
    m.stats.lastError = code;
    m.stats.lastErrorAt = Date.now();
    metrics.error(code);
    if (e instanceof FloodWaitError) {
      m.floodUntil = Math.max(m.floodUntil, Date.now() + e.seconds * 1000);
      metrics.inc("tg.floodWaits");
      metrics.inc("tg.floodWaitSeconds", e.seconds);
      log.warn(this.name, `${m.transport.label} rate-limited by Telegram for ${e.seconds}s`);
    } else if (!(e instanceof GoneError)) {
      ep?.breaker.failure();
    }
  }

  /** Runs one attempt on one endpoint, inside its priority gate, with latency + health accounting. */
  private async exec<T>(ep: Endpoint, token: PriorityToken, kind: "read" | "write" | "meta", histogram: LatencyHistogram | null, op: () => Promise<T>): Promise<T> {
    const m = ep.member;
    return ep.gate.run(token, async () => {
      if (!ep.breaker.allow()) throw new TransientError(`circuit open on ${ep.key}`);
      const t0 = performance.now();
      m.stats.requests++;
      metrics.inc("tg.requests");
      try {
        const out = await op();
        const ms = performance.now() - t0;
        if (kind === "read") {
          ep.readLatency.observe(ms);
          this.readWindow.record(ms);
        }
        else if (kind === "write") ep.writeLatency.observe(ms);
        histogram?.record(ms);
        ep.breaker.success();
        return out;
      } catch (e) {
        histogram?.record(performance.now() - t0);
        this.noteError(m, ep, e);
        throw e;
      }
    });
  }

  private member(id: unknown): Member {
    const m = this.members.find((x) => x.transport.id === id);
    if (!m) throw new UnavailableError(`Storage bot ${String(id)} is not configured any more`, 30);
    if (!m.ready) throw new UnavailableError(`${m.transport.label || m.transport.id} is reconnecting`, 10);
    return m;
  }

  private readEndpoints(): Balanceable[] {
    return this.members.flatMap((m) => m.endpoints.map((e) => e.forRead));
  }

  private endpointByKey(key: string): Endpoint {
    for (const m of this.members) for (const e of m.endpoints) if (e.key === key) return e;
    throw new Error(`unknown endpoint ${key}`);
  }

  /** P2C over every connection of every bot, optionally avoiding one bot (for hedges). */
  private pickRead(exclude: ReadonlySet<string>, avoid?: ReadonlySet<Member>): Endpoint | undefined {
    const all = this.readEndpoints();
    const avoided = avoid ? [...avoid].map((m) => `${m.transport.id}:`) : [];
    const preferred = avoided.length ? all.filter((b) => !avoided.some((prefix) => b.key.startsWith(prefix))) : all;
    const pick = pickP2C(preferred, exclude) ?? (avoided.length ? pickP2C(all, exclude) : undefined);
    return pick ? this.endpointByKey(pick.key) : undefined;
  }

  /** How long until some endpoint could serve again (flood or breaker cooldown), if ever. */
  private soonestRecoveryMs(): number | null {
    const now = Date.now();
    let best: number | null = null;
    for (const m of this.members) {
      if (!m.ready) continue;
      const wait = Math.max(0, m.floodUntil - now);
      best = best === null ? wait : Math.min(best, wait);
    }
    return best === null ? null : Math.max(best, 250);
  }

  // ---- uploads ---------------------------------------------------------------

  async beginPart(info: PartInfo): Promise<PartUploadState> {
    const pick = pickP2C(this.members.map((m) => m.asBalanceable));
    const m = pick ? this.members.find((x) => x.transport.id === pick.key)! : this.members.find((x) => x.ready);
    if (!m) throw new UnavailableError("No storage bots are available", 10);
    const fileId = crypto.randomBytes(8).readBigInt64BE().toString();
    m.assigned.add(fileId);
    return { bot: m.transport.id, fileId, big: info.size > BIG_FILE_THRESHOLD };
  }

  async writePiece(state: PartUploadState, piece: number, totalPieces: number, data: Buffer, ctx?: IoContext) {
    const token = ctx?.token ?? new PriorityToken(Normal);
    const fileId = String(state.fileId);
    const tried = new Set<string>();
    let lastError: unknown;
    for (let attempt = 0; attempt < 8; attempt++) {
      // The part is pinned: Telegram ties uploaded pieces to the uploading account.
      const m = this.member(state.bot);
      const floodMs = m.floodUntil - Date.now();
      if (floodMs > 0) {
        if (floodMs > 90_000) throw new UnavailableError(`${m.transport.label} is rate-limited`, Math.ceil(floodMs / 1000));
        await sleep(floodMs + 50);
      }
      const view = pickP2C(m.endpoints.map((e) => e.forWrite), tried) ?? pickP2C(m.endpoints.map((e) => e.forWrite));
      if (!view) {
        await sleep(Math.min(4000, 250 * 2 ** attempt));
        continue;
      }
      const ep = this.endpointByKey(view.key);
      tried.add(ep.key);
      try {
        await this.exec(ep, token, "write", metrics.latency.tgSavePart, () =>
          m.transport.uploadPiece(ep.conn, fileId, piece, totalPieces, Boolean(state.big), data),
        );
        m.stats.bytesUp += data.length;
        metrics.inc("tg.bytesUp", data.length);
        return;
      } catch (e) {
        lastError = e;
        if (e instanceof FloodWaitError) continue;
        if (e instanceof TransientError) {
          await sleep(Math.min(4000, 150 * 2 ** attempt));
          continue;
        }
        throw e;
      }
    }
    throw new UnavailableError(`Storage write keeps failing (${errorCode(lastError)})`, 5);
  }

  async commitPart(state: PartUploadState, info: PartInfo, totalPieces: number): Promise<string> {
    const fileId = String(state.fileId);
    let lastError: unknown;
    for (let attempt = 0; attempt < 6; attempt++) {
      const m = this.member(state.bot);
      // Proactive pacing: stay under Telegram's per-chat message limit instead of tripping it.
      await m.commitBucket.take();
      const view = pickP2C(m.endpoints.map((e) => e.forWrite)) ?? m.endpoints[0].forWrite;
      const ep = this.endpointByKey(view.key);
      try {
        const ref = await this.exec(ep, new PriorityToken(Interactive), "meta", metrics.latency.tgSendMedia, () =>
          m.transport.commit(ep.conn, fileId, totalPieces, Boolean(state.big), info.fileName, info.caption),
        );
        m.assigned.delete(fileId);
        return ref;
      } catch (e) {
        lastError = e;
        if (e instanceof FloodWaitError) {
          m.commitBucket.penalize(e.seconds);
          if (e.seconds > 120) throw new UnavailableError(`${m.transport.label} is rate-limited`, e.seconds);
          continue;
        }
        if (e instanceof TransientError) {
          await sleep(Math.min(4000, 250 * 2 ** attempt));
          continue;
        }
        throw e; // e.g. FILE_PART_n_MISSING → the upload layer re-requests that piece
      }
    }
    throw new UnavailableError(`Committing to storage keeps failing (${errorCode(lastError)})`, 5);
  }

  async abortPart(state: PartUploadState) {
    this.members.find((m) => m.transport.id === state.bot)?.assigned.delete(String(state.fileId));
  }

  // ---- downloads ---------------------------------------------------------------

  private async readOn(ep: Endpoint, token: PriorityToken, ref: string, offset: number, length: number): Promise<Buffer> {
    const buf = await this.exec(ep, token, "read", metrics.latency.tgGetFile, () => ep.member.transport.readBlock(ep.conn, ref, offset, length));
    ep.member.stats.bytesDown += buf.length;
    metrics.inc("tg.bytesDown", buf.length);
    return buf;
  }

  /**
   * Tail-latency hedging ("The Tail at Scale"): once a read someone is waiting
   * on has taken 3× the pool's recent median service time, fire the same read
   * at a different bot and take whichever answers first. The median is robust
   * to the stalls being hedged against — a peak-EWMA would jump to the stall
   * time and postpone the hedge until it is useless. If the hedge is slow too,
   * a second one goes to a third bot after another delay (slowness correlates
   * per DC). Budgeted to ≤10 % extra load in total.
   *
   * Readahead starts at normal priority and is only promoted to interactive
   * when the reader reaches it. A readahead block that stalls is exactly the
   * one that later freezes a download, so it is hedged too — the moment it
   * becomes the block the reader waits on.
   */
  private hedgedRead(primary: Endpoint, tried: Set<string>, token: PriorityToken, ref: string, offset: number, length: number): Promise<Buffer> {
    this.hedges.noteRequest();
    const median = this.readWindow.quantile(0.5);
    const delay = median === null ? 300 : Math.min(1000, Math.max(80, median * 3));
    const startedAt = Date.now();
    return new Promise<Buffer>((resolve, reject) => {
      let settled = false;
      let pending = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const used = new Set<Member>([primary.member]);
      const launch = (ep: Endpoint, hedge: boolean) => {
        pending++;
        this.readOn(ep, token, ref, offset, length).then(
          (buf) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (hedge) metrics.inc("lb.hedgeWins");
            resolve(buf);
          },
          (err) => {
            pending--;
            if (!settled && pending === 0) {
              settled = true;
              clearTimeout(timer);
              reject(err);
            }
          },
        );
      };
      const arm = (round: number, wait = delay) => {
        timer = setTimeout(() => {
          if (settled) return;
          // Not waited on yet (readahead), or promoted only just now: look again shortly.
          if (token.priority !== Interactive) return arm(round, 150);
          if (Date.now() - startedAt < delay) return arm(round, delay - (Date.now() - startedAt));
          const alt = this.pickRead(new Set([...tried, primary.key]), used);
          if (!alt || !this.hedges.tryHedge()) return;
          tried.add(alt.key);
          used.add(alt.member);
          metrics.inc("lb.hedges");
          launch(alt, true);
          if (round < MAX_HEDGES) arm(round + 1);
        }, wait);
        timer.unref?.();
      };
      launch(primary, false);
      arm(1);
    });
  }

  async readBlock(ref: string, offset: number, length: number, ctx?: IoContext): Promise<Buffer> {
    const token = ctx?.token ?? new PriorityToken(Normal);
    const tried = new Set<string>();
    let lastError: unknown;
    for (let attempt = 0; attempt < 6; attempt++) {
      let ep = this.pickRead(tried);
      if (!ep && tried.size) {
        tried.clear(); // everyone has had a go; allow a second round
        ep = this.pickRead(tried);
      }
      if (!ep) {
        const wait = this.soonestRecoveryMs();
        if (wait === null || wait > 30_000) {
          throw new UnavailableError("All storage bots are rate-limited or offline", wait === null ? 15 : Math.ceil(wait / 1000));
        }
        await sleep(wait + 50);
        continue;
      }
      tried.add(ep.key);
      try {
        if (this.opts.hedging && token.priority !== Background && this.members.length > 1) {
          return await this.hedgedRead(ep, tried, token, ref, offset, length);
        }
        return await this.readOn(ep, token, ref, offset, length);
      } catch (e) {
        lastError = e;
        if (e instanceof GoneError || e instanceof IntegrityError) throw e;
        metrics.inc("lb.failovers");
        if (!(e instanceof FloodWaitError) && attempt > 0) await sleep(Math.min(2000, 100 * 2 ** attempt));
      }
    }
    throw lastError instanceof Error ? lastError : new TransientError("Read failed on every storage bot");
  }

  // ---- deletes / pins ----------------------------------------------------------

  private async withAnyMember<T>(priority: Priority, fn: (ep: Endpoint) => Promise<T>): Promise<T> {
    const tried = new Set<string>();
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      const pick = pickP2C(this.members.map((m) => m.asBalanceable), tried);
      const m = pick ? this.members.find((x) => x.transport.id === pick.key)! : undefined;
      if (!m) break;
      tried.add(m.transport.id);
      const view = pickP2C(m.endpoints.map((e) => e.forWrite)) ?? m.endpoints[0].forWrite;
      const ep = this.endpointByKey(view.key);
      try {
        return await this.exec(ep, new PriorityToken(priority), "meta", null, () => fn(ep));
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError instanceof Error ? lastError : new UnavailableError("No storage bots are available", 10);
  }

  async deleteParts(refs: string[]) {
    for (let i = 0; i < refs.length; i += 100) {
      const batch = refs.slice(i, i + 100);
      // Deletions are user-visible ("it's gone from the channel"), so they run interactively.
      await this.withAnyMember(Interactive, (ep) => ep.member.transport.deleteRefs(ep.conn, batch));
    }
  }

  async pin(ref: string) {
    await this.withAnyMember(Normal, async (ep) => {
      if (!ep.member.transport.pin) return;
      await ep.member.transport.pin(ep.conn, ref);
    });
  }

  async pinnedPost(): Promise<ChannelPost | null> {
    return this.withAnyMember(Normal, (ep) => (ep.member.transport.pinnedPost ? ep.member.transport.pinnedPost(ep.conn) : Promise.resolve(null)));
  }

  async editCaption(ref: string, caption: string) {
    await this.withAnyMember(Interactive, async (ep) => {
      await ep.member.transport.editCaption?.(ep.conn, ref, caption);
    });
  }

  /** The first configured bot's live session (the one the next server can start from). */
  firstSession(): { token: string; session: string } | null {
    const t = this.transports[0];
    const session = t?.session?.() ?? null;
    return t?.token && session ? { token: t.token, session } : null;
  }

  // ---- observability -------------------------------------------------------------

  status(): DriverStatus {
    return {
      bots: this.members.map((m) => ({
        index: m.index,
        username: m.transport.label,
        id: m.transport.id,
        dcId: m.transport.dcId,
        connections: m.endpoints.length,
        connected: m.endpoints.filter((e) => m.transport.connected(e.conn)).length,
        inflight: m.endpoints.reduce((n, e) => n + e.gate.load, 0),
        requests: m.stats.requests,
        bytesUp: m.stats.bytesUp,
        bytesDown: m.stats.bytesDown,
        errors: m.stats.errors,
        floodWaitUntil: m.floodUntil,
        lastError: m.stats.lastError,
        lastErrorAt: m.stats.lastErrorAt,
        state: m.state,
        assignedParts: m.assigned.size,
        commitTokens: Math.floor(m.commitBucket.available * 10) / 10,
        endpoints: m.endpoints.map((e) => e.status()),
      })),
      channel: this.transports.find((t) => t.channel?.())?.channel?.() ?? null,
    };
  }
}
