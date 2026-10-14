"use client";
import { AlertTriangle, CheckCircle2, Clock, DatabaseBackup, Info, Loader2, Lock, LockOpen, Radio, ScanSearch, XCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { formatAgo, formatBytes, formatDuration, formatNumber, formatRate } from "@/lib/format";
import type { BotStatus, FsckReport, LatencyStats, SeriesFrame, SystemSnapshot } from "@/lib/types";
import { post } from "../api";
import { LimitsTable, roomLeftText } from "./Capacity";
import { Meter, SeriesLegend, SeriesTable, Sparkline, StackedBar, TimeSeriesChart, type Series } from "./Charts";
import { Button, cn, Spinner } from "./ui";

type SeriesState = Record<keyof SeriesFrame, number[]>;

function useSystemStream() {
  const [data, setData] = useState<{ snapshot: SystemSnapshot; series: SeriesState } | null>(null);
  const [status, setStatus] = useState<"connecting" | "live" | "reconnecting">("connecting");
  useEffect(() => {
    const es = new EventSource("/api/system/stream");
    es.addEventListener("init", (e) => {
      setData(JSON.parse((e as MessageEvent).data));
      setStatus("live");
    });
    es.addEventListener("tick", (e) => {
      const d = JSON.parse((e as MessageEvent).data) as { snapshot: SystemSnapshot; sample: SeriesFrame };
      setData((prev) =>
        prev
          ? {
              snapshot: d.snapshot,
              series: Object.fromEntries(
                Object.entries(prev.series).map(([k, arr]) => [k, [...arr.slice(1), d.sample[k as keyof SeriesFrame]]]),
              ) as SeriesState,
            }
          : prev,
      );
    });
    es.onopen = () => setStatus("live");
    es.onerror = () => setStatus("reconnecting");
    return () => es.close();
  }, []);
  return { data, status, patch: setData };
}

const ms = (v: number) => `${v < 10 ? v.toFixed(1) : Math.round(v).toLocaleString()} ms`;
const pct = (v: number) => `${v.toFixed(v < 10 && v > 0 ? 1 : 0)}%`;
const axisBytes = (v: number) => (v === 0 ? "0" : formatBytes(v, 0));
const mb = (v: number) => `${Math.round(v)} MB`;

const TYPE_COLOR: Record<string, string> = {
  Images: "var(--series-1)",
  Videos: "var(--series-2)",
  Audio: "var(--series-3)",
  Documents: "var(--series-4)",
  Archives: "var(--series-5)",
  Other: "var(--series-6)",
};

function Card({ title, kicker, subtitle, action, children, className }: { title: string; kicker?: string; subtitle?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn(" border border-line bg-surface-2/50 p-5", className)}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          {kicker ? <div className="label mb-0.5 text-accent">{kicker}</div> : null}
          <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
          {subtitle ? <div className="mt-0.5 text-xs text-ink-3">{subtitle}</div> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function StatTile({ label, value, sub, trend, accent }: { label: string; value: string; sub?: ReactNode; trend?: number[]; accent?: string }) {
  return (
    <div className="flex min-w-0 flex-col border border-line bg-surface p-4">
      <div className="label min-w-0 text-ink-3">{label}</div>
      {/* Values line up under the labels, sub-lines along the bottom, across a row. */}
      <div className="mt-2 whitespace-nowrap text-[24px] font-semibold leading-none tracking-tight text-ink tabular">{value}</div>
      <div className="mt-auto pt-2">
        {trend ? (
          <div className="opacity-90">
            <Sparkline values={trend} accent={accent} fluid />
          </div>
        ) : null}
        {sub ? <div className="mt-1.5 truncate text-xs text-ink-3">{sub}</div> : null}
      </div>
    </div>
  );
}

type Tone = "good" | "warning" | "critical" | "neutral";
const TONE_COLOR: Record<Tone, string> = { good: "var(--status-good)", warning: "var(--status-warning)", critical: "var(--status-critical)", neutral: "var(--ink-3)" };

function StatusLabel({ tone, children, spin = true }: { tone: Tone; children: ReactNode; spin?: boolean }) {
  const Icon = tone === "good" ? CheckCircle2 : tone === "warning" ? Clock : tone === "critical" ? XCircle : Loader2;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-ink">
      <Icon className={cn("size-4 shrink-0", tone === "neutral" && spin && "animate-spin")} style={{ color: TONE_COLOR[tone] }} />
      {children}
    </span>
  );
}

function botTone(b: BotStatus, now: number): { tone: Tone; label: string } {
  if (b.state === "error") return { tone: "critical", label: "Offline" };
  if (b.state === "connecting") return { tone: "neutral", label: "Connecting" };
  if (b.floodWaitUntil > now) return { tone: "warning", label: `Rate-limited · ${Math.ceil((b.floodWaitUntil - now) / 1000)}s` };
  return { tone: "good", label: "Online" };
}

const DECK_TONE: Record<Tone, string> = { good: "var(--success)", warning: "var(--warning)", critical: "var(--danger)", neutral: "var(--ink-3)" };

const LATENCY_LABELS: Record<string, string> = {
  tgGetFile: "Block fetch (1 MiB)",
  tgSavePart: "Piece upload (512 KiB)",
  tgSendMedia: "Part commit (sendMedia)",
  tgGetMessages: "Location lookup",
  timeToFirstByte: "Stream time-to-first-byte",
  apiList: "Folder listing (API)",
};

/** The fleet on a radar scope: one blip per bot, further out = busier. */
function FleetRadar({ bots, now, driver }: { bots: BotStatus[]; now: number; driver: SystemSnapshot["driver"] }) {
  const C = 100;
  const R = 86;
  const wedge = `M${C} ${C} L${C} ${C - R} A${R} ${R} 0 0 1 ${C + R * Math.sin(Math.PI / 5)} ${C - R * Math.cos(Math.PI / 5)} Z`;
  return (
    <svg viewBox="0 0 200 200" className="size-full max-h-[220px] max-w-[220px]" role="img" aria-label={`Bot radar: ${bots.length || 1} storage node${bots.length === 1 ? "" : "s"}`}>
      <defs>
        <linearGradient id="sweep" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="var(--accent)" stopOpacity="0.45" />
          <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[R, R * 0.66, R * 0.33].map((r) => (
        <circle key={r} cx={C} cy={C} r={r} fill="none" stroke="var(--line)" strokeWidth="1" />
      ))}
      <line x1={C - R} x2={C + R} y1={C} y2={C} stroke="var(--line)" />
      <line y1={C - R} y2={C + R} x1={C} x2={C} stroke="var(--line)" />
      <g className="animate-sweep" style={{ transformOrigin: `${C}px ${C}px` }}>
        <path d={wedge} fill="url(#sweep)" />
      </g>
      {bots.length ? (
        bots.map((b, i) => {
          const angle = (i / bots.length) * Math.PI * 2 - Math.PI / 2 + 0.4;
          const load = Math.min(1, (b.inflight + b.assignedParts) / 12);
          const r = R * (0.38 + 0.5 * load);
          const x = C + r * Math.cos(angle);
          const y = C + r * Math.sin(angle);
          const color = DECK_TONE[botTone(b, now).tone];
          return (
            <g key={b.id}>
              <circle cx={x} cy={y} r="4.5" fill={color} />
              <circle cx={x} cy={y} r="9" fill="none" stroke={color} strokeOpacity="0.45" />
              <text x={x} y={y + 19} textAnchor="middle" fontSize="8.5" fontFamily="var(--font-mono)" fill="var(--ink-3)">
                {(b.username || `bot${b.index}`).replace(/^@/, "").slice(0, 14)}
              </text>
            </g>
          );
        })
      ) : (
        <g>
          <circle cx={C} cy={C} r="5" fill="var(--success)" />
          <text x={C} y={C + 20} textAnchor="middle" fontSize="8.5" fontFamily="var(--font-mono)" fill="var(--ink-3)">
            {driver === "local" ? "LOCAL DISK" : "STANDBY"}
          </text>
        </g>
      )}
    </svg>
  );
}

const BREAKER_TONE: Record<"closed" | "open" | "half-open", Tone> = { closed: "good", "half-open": "warning", open: "critical" };

function LoadBalancerTable({ bots }: { bots: BotStatus[] }) {
  const rows = bots.flatMap((b) => b.endpoints.map((e) => ({ b, e })));
  if (!rows.length) return <p className="text-sm text-ink-3">No connections yet.</p>;
  return (
    <div className="-mx-2 overflow-x-auto">
      <table className="w-full min-w-[760px] text-sm tabular">
        <thead>
          <tr className="text-left text-xs text-ink-3">
            {["Bot", "Conn", "Breaker", "Active", "Queued", "Read EWMA", "Write EWMA", "Served · interactive / normal / background"].map((h, i) => (
              <th key={h} className={cn("px-2 pb-2 font-normal", i >= 3 && "text-right")}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ b, e }) => (
            <tr key={`${b.id}:${e.conn}`} className="border-t border-line">
              <td className="px-2 py-2 font-medium text-ink">{b.username || `bot ${b.id}`}</td>
              <td className="px-2 text-ink-2">
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-1.5 rounded-full" style={{ background: e.connected ? "var(--status-good)" : "var(--status-critical)" }} />#{e.conn}
                </span>
              </td>
              <td className="px-2">
                <StatusLabel tone={BREAKER_TONE[e.breaker]} spin={false}>
                  {e.breaker}
                </StatusLabel>
              </td>
              <td className="px-2 text-right text-ink">{e.active}</td>
              <td className="px-2 text-right text-ink-2">{e.queued}</td>
              <td className="px-2 text-right text-ink-2">{e.readLatencyMs ? ms(e.readLatencyMs) : "—"}</td>
              <td className="px-2 text-right text-ink-2">{e.writeLatencyMs ? ms(e.writeLatencyMs) : "—"}</td>
              <td className="px-2 text-right text-ink-2">{e.served.map((n) => formatNumber(n)).join(" / ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CounterGrid({ items, wide }: { items: [string, string, string?][]; wide?: boolean }) {
  return (
    <dl className={cn("grid grid-cols-2 gap-2.5 sm:grid-cols-3", wide && "xl:grid-cols-6")}>
      {items.map(([k, v, hint]) => (
        <div key={k} className=" border border-line bg-surface p-3" title={hint}>
          <dt className="truncate text-xs text-ink-3">{k}</dt>
          <dd className="mt-1 text-lg font-semibold text-ink tabular">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const CHECK_TONE: Record<FsckReport["checks"][number]["status"], Tone> = { ok: "good", repaired: "warning", warning: "warning", error: "critical" };

function IntegrityCard({ s, onReport }: { s: SystemSnapshot; onReport: (r: FsckReport) => void }) {
  const [running, setRunning] = useState(false);
  const i = s.integrity;
  const c = s.counters;
  const checksummed = i.total - i.legacy;
  const report = i.fsck;
  return (
    <Card
      kicker="Integrity"
      title="Checksums, scrubber & fsck"
      subtitle={i.enabled ? (i.running ? "Scrubber is re-reading stored bytes now" : "Scrubber re-reads stored bytes while the system is idle") : "Scrubber disabled (SCRUB_MBPS=0)"}
      action={
        <Button
          size="sm"
          variant="soft"
          disabled={running}
          data-testid="run-fsck"
          onClick={async () => {
            setRunning(true);
            try {
              const { report } = await post<{ report: FsckReport }>("/api/system/fsck");
              onReport(report);
              const issues = report.checks.filter((x) => x.status !== "ok").length;
              if (report.ok) toast.success(issues ? `Index consistent — ${report.repaired} item${report.repaired === 1 ? "" : "s"} repaired` : "Index is fully consistent");
              else toast.error("The checker found problems it could not repair", { description: "See the check list on the System page." });
            } catch (e) {
              toast.error((e as Error).message);
            } finally {
              setRunning(false);
            }
          }}
        >
          {running ? <Spinner className="size-4" /> : <ScanSearch className="size-4" />} Run check
        </Button>
      }
    >
      <Meter
        label="Read back & verified"
        value={checksummed ? i.verified / checksummed : 0}
        detail={`${i.verified.toLocaleString()} of ${checksummed.toLocaleString()} checksummed blobs${i.legacy ? ` · ${i.legacy.toLocaleString()} legacy (no checksum)` : ""}`}
      />
      <div className="mt-4">
        <CounterGrid
          items={[
            ["Corrupt blobs", i.corrupt.toLocaleString(), "Blobs whose stored bytes no longer match their checksums"],
            ["Blocks verified", formatNumber(c["integrity.blocksVerified"]), "Every read block is checked against its piece SHA-256s"],
            ["Healed reads", formatNumber(c["integrity.refetches"]), "Corrupt reads re-fetched and served correctly"],
            ["Cache evictions", formatNumber(c["integrity.cacheEvictions"]), "Damaged cache entries dropped"],
            ["Files verified", formatNumber(c["integrity.filesVerified"]), "Whole-file SHA-256 matched on full reads"],
            ["Scrubbed", formatBytes(c["scrub.bytes"]), "Bytes re-read from storage by the scrubber"],
          ]}
        />
      </div>
      <div className="mt-5">
        <div className="mb-2 flex items-center justify-between">
          <span className="label text-ink-3">Index check (fsck)</span>
          <span className="text-xs text-ink-3">
            {report ? `${formatAgo(report.at)} · ${report.durationMs.toFixed(0)} ms · ${report.repaired} repaired` : "not run yet"}
          </span>
        </div>
        {report ? (
          <ul className="divide-y divide-line border border-line bg-surface" data-testid="fsck-checks">
            {report.checks.map((x) => (
              <li key={x.name} className="flex items-start gap-3 px-3 py-2">
                <StatusLabel tone={CHECK_TONE[x.status]} spin={false}>
                  <span className="font-medium">{x.name}</span>
                </StatusLabel>
                <span className="ml-auto min-w-0 truncate text-right text-xs text-ink-3" title={x.detail}>
                  {x.detail}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-3">Runs at boot and every few hours.</p>
        )}
      </div>
    </Card>
  );
}

export function Dashboard() {
  const { data, status, patch } = useSystemStream();
  const [backingUp, setBackingUp] = useState(false);
  const now = data?.snapshot.ts ?? 0;

  useEffect(() => {
    document.title = "System · Telestorage";
  }, []);

  const series = data?.series;
  const last60 = (k: keyof SeriesFrame) => (series ? series[k].slice(-60) : []);
  const hitWindow = series ? series.cacheHitRatio.slice(-60).filter((v) => v >= 0) : [];
  const hitRate = hitWindow.length ? (hitWindow.reduce((a, b) => a + b, 0) / hitWindow.length) * 100 : null;

  const charts = useMemo(() => {
    if (!series) return null;
    const throughput: Series[] = [
      { key: "down", label: "From storage", color: "var(--series-1)", values: series.tgDown },
      { key: "up", label: "To storage", color: "var(--series-2)", values: series.tgUp },
      { key: "served", label: "Served to clients", color: "var(--series-3)", values: series.served },
    ];
    return {
      throughput,
      rps: [{ key: "rps", label: "RPCs per second", color: "var(--series-1)", values: series.tgRps }],
      hit: [{ key: "hit", label: "Cache hit rate", color: "var(--series-1)", values: series.cacheHitRatio.map((v) => (v < 0 ? null : v * 100)) }],
      cpu: [{ key: "cpu", label: "CPU", color: "var(--series-1)", values: series.cpuPct }],
      mem: [
        { key: "rss", label: "Resident set", color: "var(--series-1)", values: series.rssMb },
        { key: "heap", label: "JS heap", color: "var(--series-2)", values: series.heapMb },
      ],
      lag: [{ key: "lag", label: "Event-loop delay p99", color: "var(--series-1)", values: series.loopLagMs }],
    };
  }, [series]);

  if (!data || !charts) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-ink-2">
        <Spinner className="size-7" />
        Connecting to live metrics…
      </div>
    );
  }

  const s = data.snapshot;
  const st = s.storage;
  const botsReady = s.bots.filter((b) => b.state === "ready").length;
  const c = s.counters;
  const cacheLookups = c["cache.memHits"] + c["cache.diskHits"] + c["cache.misses"];
  const pooled = s.driver !== "local";
  const backend = s.driver === "telegram" ? `Telegram · ${s.channel?.title ?? "channel"}` : s.driver === "sim" ? "Simulated bots (test mode)" : "Local disk (no Telegram configured)";

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[1400px] space-y-4 p-4 md:p-6">
        {/* Header */}
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[32px] font-semibold leading-none tracking-[-0.02em] text-ink">System status</h1>
          <span
            className={cn("label inline-flex h-7 items-center gap-1.5 px-2.5", status === "live" ? "bg-success-soft text-success" : "bg-warning-soft text-warning")}
            data-testid="tower-status"
          >
            <Radio className={cn("size-3.5", status === "live" && "animate-pulse")} />
            {status === "live" ? "Live" : status === "connecting" ? "Connecting" : "Reconnecting"}
          </span>
          <span className="text-xs text-ink-3">
            {backend} · up {formatDuration(s.uptimeSec)} · Node {s.node} · {s.platform}
          </span>
          <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-ink-2">
            {s.encryption ? <Lock className="size-3.5 text-success" /> : <LockOpen className="size-3.5 text-ink-3" />}
            {s.encryption ? "AES-256 encryption on" : "Encryption off"}
          </span>
        </div>

        {/* Hero + KPI row */}
        <div className="grid gap-3 lg:grid-cols-[minmax(380px,1.35fr)_3fr]">
          <div className="relative overflow-hidden border-[1.5px] border-line-strong bg-surface p-5 text-ink">
            <div className="flex items-center gap-4">
              <div className="min-w-0 flex-1">
                <div className="label text-ink-3">Stored</div>
                <div className="mt-2 whitespace-nowrap text-[clamp(34px,3.4vw,48px)] font-semibold leading-none tracking-[-0.03em] text-ink">{formatBytes(st.logicalBytes)}</div>
                <div className="mt-3 text-sm text-ink-2">
                  {st.files.toLocaleString()} file{st.files === 1 ? "" : "s"} · {st.folders.toLocaleString()} folder{st.folders === 1 ? "" : "s"}
                </div>
                <div className="mt-1 text-[12.5px] text-ink-3">
                  {formatBytes(st.physicalBytes)} actually stored · {st.parts.toLocaleString()} {s.driver === "telegram" ? "posts" : "parts"}
                </div>
                <div className="mt-3 inline-flex items-center gap-1.5 bg-accent px-2 py-1 text-[12px] font-semibold text-on-accent tabular">{roomLeftText(st.capacity)}</div>
              </div>
              <div className="flex w-[42%] shrink-0 justify-center">
                <FleetRadar bots={s.bots} now={now} driver={s.driver} />
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatTile label="Download from storage" value={formatRate(series!.tgDown.at(-1) ?? 0)} trend={last60("tgDown")} sub={`${formatBytes(c["tg.bytesDown"])} total`} />
            <StatTile label="Upload to storage" value={formatRate(series!.tgUp.at(-1) ?? 0)} trend={last60("tgUp")} accent="var(--series-2)" sub={`${formatBytes(c["tg.bytesUp"])} total`} />
            <StatTile label="Served to clients" value={formatRate(series!.served.at(-1) ?? 0)} trend={last60("served")} accent="var(--series-3)" sub={`${formatBytes(c["http.bytesOut"])} total`} />
            <StatTile label="Cache hit rate (60 s)" value={hitRate === null ? "idle" : pct(hitRate)} sub={`${formatNumber(cacheLookups)} block lookups`} />
            <StatTile label="Block fetch p50" value={s.latency.tgGetFile.count ? ms(s.latency.tgGetFile.p50) : "—"} sub={s.latency.tgGetFile.count ? `p99 ${ms(s.latency.tgGetFile.p99)}` : "no fetches yet"} />
            <StatTile label="Time to first byte" value={s.latency.timeToFirstByte.count ? ms(s.latency.timeToFirstByte.p50) : "—"} sub="median, all streams" />
            <StatTile
              label="Active streams"
              value={String(s.gauges.activeStreams)}
              sub={`${s.gauges.activeUploads} uploads · ${s.gauges.liveClients} live tab${s.gauges.liveClients === 1 ? "" : "s"}`}
              trend={last60("activeStreams")}
            />
            <StatTile
              label="Bots"
              value={pooled ? `${botsReady} / ${s.bots.length}` : "local"}
              sub={pooled ? `${s.bots.reduce((a, b) => a + b.connected, 0)} connections up` : "no Telegram configured"}
            />
          </div>
        </div>

        {/* The real limits */}
        <Card kicker="Capacity" title="How much fits" subtitle={s.driver === "telegram" ? "Telegram's actual limits, and where this drive stands" : "Where this drive stands"}>
          <LimitsTable cap={st.capacity} bots={s.bots.length} simulated={s.driver === "sim"} />
        </Card>

        {/* Throughput + RPC */}
        <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
          <Card kicker="Traffic" title="Throughput" subtitle="Bytes per second, last 5 minutes" action={<SeriesLegend series={charts.throughput} format={formatRate} />}>
            <TimeSeriesChart series={charts.throughput} format={formatRate} axisFormat={axisBytes} binary height={220} ariaLabel="Throughput to and from storage and to clients over the last five minutes" />
            <SeriesTable series={charts.throughput} format={formatRate} />
          </Card>
          <Card kicker="Traffic" title="Storage RPC rate" subtitle={`${formatNumber(c["tg.requests"])} requests · ${formatNumber(c["tg.errors"])} errors · ${c["tg.floodWaits"]} flood waits (${c["tg.floodWaitSeconds"]} s)`}>
            <TimeSeriesChart series={charts.rps} format={(v) => `${v.toFixed(1)}/s`} axisFormat={(v) => formatNumber(v)} height={220} ariaLabel="Storage RPCs per second" />
            <SeriesTable series={charts.rps} format={(v) => `${v.toFixed(1)}/s`} />
          </Card>
        </div>

        {/* Fleet */}
        <Card
          kicker="Bots"
          title="Bots"
          subtitle={pooled ? "Each bot is an independent MTProto session with its own rate limits. Upload parts are pinned to a bot; reads fail over and hedge across all of them." : undefined}
        >
          {!pooled ? (
            <p className="flex items-center gap-2 text-sm text-ink-2">
              <Info className="size-4" /> Running on the local-disk driver. Set TG_API_ID, TG_API_HASH, TG_BOT_TOKENS and TG_CHANNEL_ID to store files in Telegram.
            </p>
          ) : (
            <div className="-mx-2 overflow-x-auto">
              <table className="w-full min-w-[920px] text-sm">
                <thead>
                  <tr className="text-left text-xs text-ink-3">
                    {["Bot", "Status", "DC", "Conns", "In flight", "Parts pinned", "Commit tokens", "Requests", "Down", "Up", "Errors", "Last error"].map((h, i) => (
                      <th key={h} className={cn("px-2 pb-2 font-normal", i >= 2 && i <= 10 && "text-right")}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="tabular">
                  {s.bots.map((b) => {
                    const t = botTone(b, now);
                    return (
                      <tr key={b.id} className="border-t border-line">
                        <td className="px-2 py-2.5">
                          <div className="font-medium text-ink">{b.username || `bot ${b.id}`}</div>
                          <div className="font-mono text-[11px] text-ink-3">id {b.id}</div>
                        </td>
                        <td className="px-2">
                          <StatusLabel tone={t.tone}>{t.label}</StatusLabel>
                        </td>
                        <td className="px-2 text-right text-ink-2">{b.dcId || "—"}</td>
                        <td className="px-2 text-right text-ink-2">
                          {b.connected}/{b.connections}
                        </td>
                        <td className="px-2 text-right text-ink">{b.inflight}</td>
                        <td className="px-2 text-right text-ink-2">{b.assignedParts}</td>
                        <td className="px-2 text-right text-ink-2">{b.commitTokens.toFixed(1)}</td>
                        <td className="px-2 text-right text-ink-2">{formatNumber(b.requests)}</td>
                        <td className="px-2 text-right text-ink-2">{formatBytes(b.bytesDown)}</td>
                        <td className="px-2 text-right text-ink-2">{formatBytes(b.bytesUp)}</td>
                        <td className="px-2 text-right text-ink-2">{b.errors}</td>
                        <td className="max-w-[220px] truncate px-2 text-xs text-ink-3" title={b.lastError ?? undefined}>
                          {b.lastError ? `${b.lastError} · ${formatAgo(b.lastErrorAt ?? now)}` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* Load balancer + reliability */}
        {pooled ? (
          <div className="grid gap-4">
            <Card
              kicker="Load balancer"
              title="Connections"
              subtitle="Power-of-two-choices over peak-EWMA latency × queue depth, with a circuit breaker per connection and priority lanes (interactive reads first)."
            >
              <LoadBalancerTable bots={s.bots} />
            </Card>
            <Card kicker="Reliability" title="Retries, hedges & admission" subtitle="Everything that went wrong — and was absorbed">
              <Meter
                label="Upload admission"
                value={s.admission.capacity ? s.admission.used / s.admission.capacity : 0}
                detail={`${formatBytes(s.admission.used)} of ${formatBytes(s.admission.capacity)} buffered · ${s.admission.queued} queued · ${formatNumber(s.admission.rejected)} shed (503)`}
              />
              <div className="mt-4">
                <CounterGrid
                  wide
                  items={[
                    ["Failovers", formatNumber(c["lb.failovers"]), "Reads retried on another bot or connection"],
                    ["Hedged reads", `${formatNumber(c["lb.hedgeWins"])} / ${formatNumber(c["lb.hedges"])}`, "Backup requests that won / were sent"],
                    ["Chunks received", formatNumber(c["upload.chunks"])],
                    ["Digest rejects", formatNumber(c["upload.digestMismatches"]), "Chunks damaged in transit (Content-Digest mismatch), resent by the client"],
                    ["Parts re-sent", formatNumber(c["upload.partsRedone"] + c["upload.piecesResent"]), "Parts redone after a window-hash mismatch, plus pieces resent after a dropped write"],
                    ["Idempotent replays", formatNumber(c["idempotency.replays"]), "Retried requests answered from the first outcome"],
                  ]}
                />
              </div>
            </Card>
          </div>
        ) : null}

        {/* Integrity + cache */}
        <div className="grid gap-4 lg:grid-cols-2">
          <IntegrityCard s={s} onReport={(report) => patch((prev) => (prev ? { ...prev, snapshot: { ...prev.snapshot, integrity: { ...prev.snapshot.integrity, fsck: report } } } : prev))} />
          <Card kicker="Cache" title="Block cache" subtitle="Memory LRU → disk LRU → storage, with in-flight request coalescing">
            <div className="space-y-4">
              <Meter label="Memory" value={s.cache.memMax ? s.cache.memBytes / s.cache.memMax : 0} detail={`${formatBytes(s.cache.memBytes)} of ${formatBytes(s.cache.memMax)} · ${s.cache.memEntries.toLocaleString()} blocks`} />
              <Meter label="Disk" value={s.cache.diskMax ? s.cache.diskBytes / s.cache.diskMax : 0} detail={s.cache.diskMax ? `${formatBytes(s.cache.diskBytes)} of ${formatBytes(s.cache.diskMax)} · ${s.cache.diskEntries.toLocaleString()} blocks` : "disabled"} />
            </div>
            <div className="mt-5">
              <CounterGrid
                items={[
                  ["Memory hits", formatNumber(c["cache.memHits"])],
                  ["Disk hits", formatNumber(c["cache.diskHits"])],
                  ["Misses", formatNumber(c["cache.misses"])],
                  ["Coalesced", formatNumber(c["cache.coalesced"]), "Concurrent requests for the same block that shared one fetch"],
                ]}
              />
            </div>
            <div className="mt-5">
              <div className="mb-2 text-xs text-ink-2">Hit rate per second (%)</div>
              <TimeSeriesChart series={charts.hit} format={pct} axisFormat={(v) => `${v}%`} yMax={100} height={120} ariaLabel="Cache hit rate per second" />
            </div>
          </Card>
        </div>

        {/* Latency */}
        <Card kicker="Latency" title="Operation timings" subtitle="Percentiles over the most recent 2,048 samples per operation">
          <LatencyTable latency={s.latency} />
        </Card>

        {/* Storage */}
        <div className="grid gap-4 lg:grid-cols-2">
          <Card kicker="Content" title="What’s stored" subtitle="Bytes by file type (excluding the trash)">
            <StackedBar
              format={(v) => formatBytes(v)}
              segments={["Images", "Videos", "Audio", "Documents", "Archives", "Other"].map((type) => ({
                key: type,
                label: type,
                value: st.byType.find((t) => t.type === type)?.bytes ?? 0,
                color: TYPE_COLOR[type],
              }))}
            />
            <table className="mt-5 w-full text-sm tabular">
              <thead>
                <tr className="text-left text-xs text-ink-3">
                  <th className="pb-1 font-normal">Type</th>
                  <th className="pb-1 text-right font-normal">Files</th>
                  <th className="pb-1 text-right font-normal">Size</th>
                </tr>
              </thead>
              <tbody>
                {st.byType.map((t) => (
                  <tr key={t.type} className="border-t border-line">
                    <td className="py-1.5 text-ink">{t.type}</td>
                    <td className="py-1.5 text-right text-ink-2">{t.count.toLocaleString()}</td>
                    <td className="py-1.5 text-right text-ink-2">{formatBytes(t.bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card
            kicker="Storage"
            title="Storage internals"
            subtitle={
              !s.backup.enabled
                ? "Automatic index backups are off (BACKUP_INTERVAL_HOURS=0)"
                : s.backup.pending
                  ? `Changes waiting to be backed up${s.backup.lastAt ? ` · last backup ${formatAgo(s.backup.lastAt)}` : ""}`
                  : s.backup.lastAt
                    ? `Index backed up ${formatAgo(s.backup.lastAt)} (${formatBytes(s.backup.lastSize ?? 0)})${s.driver === "local" ? "" : ", pinned in the channel"}`
                    : "No index backup yet"
            }
            action={
              <Button
                size="sm"
                variant="soft"
                disabled={backingUp}
                onClick={async () => {
                  setBackingUp(true);
                  try {
                    await post("/api/system/backup");
                    toast.success("Index backed up", { description: s.driver === "local" ? "Saved to the data folder." : "Pinned in your Telegram channel." });
                  } catch (e) {
                    toast.error((e as Error).message);
                  } finally {
                    setBackingUp(false);
                  }
                }}
              >
                {backingUp ? <Spinner className="size-4" /> : <DatabaseBackup className="size-4" />} Back up now
              </Button>
            }
          >
            {s.backup.lastError ? (
              <p className="mb-3 flex items-center gap-2 bg-danger-soft px-3 py-2 text-xs text-danger">
                <AlertTriangle className="size-4" /> Backup failed: {s.backup.lastError}
              </p>
            ) : null}
            {s.backup.notice ? (
              <p className="mb-3 flex items-start gap-2 bg-warning-soft px-3 py-2 text-xs leading-relaxed text-warning" data-testid="backup-notice">
                <AlertTriangle className="mt-px size-4 shrink-0" /> {s.backup.notice.message}
              </p>
            ) : null}
            {s.backup.restoredAt ? (
              <p className="mb-3 flex items-start gap-2 bg-surface-2 px-3 py-2 text-xs leading-relaxed text-ink-2" data-testid="backup-restored">
                <Info className="mt-px size-4 shrink-0" />
                This server started on an empty disk {formatAgo(s.backup.restoredAt)} and brought the index back from Telegram
                {s.backup.restoredBackupAt ? ` (a backup made ${formatAgo(s.backup.restoredBackupAt)})` : ""}.
              </p>
            ) : null}
            <dl className="grid grid-cols-2 gap-x-6 text-sm">
              {(
                [
                  ["Unique blobs", st.blobs.toLocaleString()],
                  ["Storage parts", st.parts.toLocaleString()],
                  ["Saved by dedup", formatBytes(st.dedupSavedBytes)],
                  ["In the trash", formatBytes(st.trashedBytes)],
                  ["Trash retention", s.trashRetentionDays > 0 ? `${s.trashRetentionDays} days` : "forever"],
                  ["GC queue", `${st.gcPending} part${st.gcPending === 1 ? "" : "s"}`],
                  ["Parts removed (GC)", formatNumber(c["gc.partsDeleted"])],
                  ["Index database", formatBytes(st.dbBytes)],
                  ["Write-ahead log", formatBytes(st.walBytes)],
                  ["Thumbnails", formatBytes(st.thumbBytes)],
                  ["Share links", st.shares.toLocaleString()],
                  ["Uploads completed", formatNumber(c["uploads.completed"])],
                  ["Uploads deduped", `${formatNumber(c["uploads.deduped"])} (${formatBytes(c["uploads.bytesDeduped"])})`],
                  ["Live-feed events", formatNumber(c["events.emitted"])],
                ] as [string, string][]
              ).map(([k, v]) => (
                <div key={k} className="flex items-baseline justify-between gap-3 border-b border-line py-2">
                  <dt className="text-ink-2">{k}</dt>
                  <dd className="text-right text-ink tabular">{v}</dd>
                </div>
              ))}
            </dl>
          </Card>
        </div>

        {/* Process (small multiples, one unit per chart) */}
        <div className="grid gap-4 lg:grid-cols-3">
          <Card kicker="Process" title="CPU" subtitle={`Process time per wall-second · ${s.process.cpus} cores${s.process.loadAvg.some((l) => l > 0) ? ` · load ${s.process.loadAvg.map((l) => l.toFixed(2)).join(" ")}` : ""}`}>
            <TimeSeriesChart series={charts.cpu} format={pct} axisFormat={(v) => `${v}%`} height={140} ariaLabel="Process CPU usage" />
            <SeriesTable series={charts.cpu} format={pct} />
          </Card>
          <Card kicker="Process" title="Memory" subtitle={`Heap ${formatBytes(s.process.heapUsedBytes)} of ${formatBytes(s.process.heapTotalBytes)} · buffers ${formatBytes(s.process.externalBytes)}`} action={<SeriesLegend series={charts.mem} format={mb} />}>
            <TimeSeriesChart series={charts.mem} format={mb} axisFormat={(v) => `${v}`} height={140} ariaLabel="Resident memory and JavaScript heap in megabytes" />
            <SeriesTable series={charts.mem} format={mb} />
          </Card>
          <Card kicker="Process" title="Event-loop delay" subtitle="p99 per second — spikes mean the server is CPU-starved">
            <TimeSeriesChart series={charts.lag} format={ms} axisFormat={(v) => `${v}`} height={140} ariaLabel="Event loop delay p99 in milliseconds" />
            <SeriesTable series={charts.lag} format={ms} />
          </Card>
        </div>

        {/* Errors + log */}
        <div className="grid gap-4 lg:grid-cols-[1fr_2fr]">
          <Card kicker="Errors" title="Errors by code" subtitle="Storage RPC and transport errors since start">
            {s.errors.length ? (
              <table className="w-full text-sm tabular">
                <tbody>
                  {s.errors.map((e) => (
                    <tr key={e.code} className="border-t border-line first:border-0">
                      <td className="max-w-0 truncate py-1.5 pr-3 font-mono text-xs text-ink" title={e.code}>
                        {e.code}
                      </td>
                      <td className="py-1.5 text-right text-ink-2">{e.count.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <StatusLabel tone="good">No errors recorded</StatusLabel>
            )}
          </Card>
          <Card kicker="Log" title="Server log" subtitle="Live tail of server events">
            <LogTail logs={s.logs} />
          </Card>
        </div>
      </div>
    </div>
  );
}

function LatencyTable({ latency }: { latency: Record<string, LatencyStats> }) {
  const rows = Object.entries(LATENCY_LABELS).map(([k, label]) => ({ k, label, l: latency[k] }));
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full min-w-[480px] text-sm tabular">
        <thead>
          <tr className="text-xs text-ink-3">
            <th className="px-1 pb-2 text-left font-normal">Operation</th>
            {["Count", "p50", "p90", "p99", "Max"].map((h) => (
              <th key={h} className="px-1 pb-2 text-right font-normal">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ k, label, l }) => (
            <tr key={k} className="border-t border-line">
              <td className="px-1 py-2 text-ink">{label}</td>
              <td className="px-1 text-right text-ink-2">{l?.count ? formatNumber(l.count) : "—"}</td>
              {(["p50", "p90", "p99", "max"] as const).map((q) => (
                <td key={q} className={cn("px-1 text-right", q === "p50" ? "font-medium text-ink" : "text-ink-2")}>
                  {l?.count ? ms(l[q]) : "—"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LogTail({ logs }: { logs: SystemSnapshot["logs"] }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [logs]);
  return (
    <div
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      className="h-64 overflow-y-auto bg-[#111] p-3 font-mono text-xs leading-5 text-[#efeae1]"
    >
      {logs.length ? (
        logs.map((l, i) => (
          <div key={`${l.ts}-${i}`} className="flex gap-3">
            <span className="shrink-0 text-[#efeae1]/60">{new Date(l.ts).toLocaleTimeString()}</span>
            <span className="w-14 shrink-0">
              {l.level === "info" ? (
                <span className="text-[#efeae1]/60">info</span>
              ) : (
                <span className="inline-flex items-center gap-1" style={{ color: l.level === "warn" ? "#fab219" : "#ff7a66" }}>
                  {l.level === "warn" ? <AlertTriangle className="size-3" /> : <XCircle className="size-3" />}
                  {l.level}
                </span>
              )}
            </span>
            <span className="shrink-0 text-accent">{l.scope}</span>
            <span className="min-w-0 break-words">{l.msg}</span>
          </div>
        ))
      ) : (
        <span className="text-[#efeae1]/60">No events yet.</span>
      )}
    </div>
  );
}
