"use client";
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "./ui";

export interface Series {
  key: string;
  label: string;
  /** CSS colour (a --series-N token). */
  color: string;
  /** One value per second, oldest → newest. `null` = no data (gap). */
  values: (number | null)[];
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Rounds up to 1 / 2 / 2.5 / 5 × 10^k so ticks land on clean numbers. */
function niceStep(raw: number) {
  if (raw <= 0 || !Number.isFinite(raw)) return 1;
  const exp = Math.floor(Math.log10(raw));
  const base = raw / 10 ** exp;
  const nice = base <= 1 ? 1 : base <= 2 ? 2 : base <= 2.5 ? 2.5 : base <= 5 ? 5 : 10;
  return nice * 10 ** exp;
}

const agoLabel = (secondsAgo: number) => (secondsAgo === 0 ? "now" : secondsAgo < 60 ? `${secondsAgo}s ago` : `${Math.floor(secondsAgo / 60)}m ${secondsAgo % 60}s ago`);

/**
 * Line chart for the dashboard's per-second series: hairline grid, 2 px lines,
 * a 10 % area wash for single series, ringed end-dots, a snapping crosshair with
 * an all-series tooltip, arrow-key navigation, and a table-view twin.
 */
export function TimeSeriesChart({
  series,
  format,
  axisFormat = format,
  height = 168,
  yMax,
  binary = false,
  ariaLabel,
}: {
  series: Series[];
  format: (v: number) => string;
  axisFormat?: (v: number) => string;
  height?: number;
  /** Fixed ceiling (e.g. 100 for percentages); otherwise derived from data. */
  yMax?: number;
  /** Step ticks in powers of 1024 (bytes) so labels read 1 MB, 2 MB… not 977 KB. */
  binary?: boolean;
  ariaLabel: string;
}) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = series[0]?.values.length ?? 0;
  const left = 52;
  const right = 14;
  const top = 10;
  const bottom = 24;
  const plotW = Math.max(10, width - left - right);
  const plotH = height - top - bottom;

  const { step, ceil } = useMemo(() => {
    let max = 0;
    for (const s of series) for (const v of s.values) if (v !== null && v > max) max = v;
    if (yMax !== undefined) return { step: yMax / 4, ceil: yMax };
    const unit = binary && max > 0 ? 1024 ** Math.max(0, Math.floor(Math.log(max) / Math.log(1024))) : 1;
    const st = niceStep(max / 4 / unit) * unit;
    return { step: st, ceil: st * 4 };
  }, [series, yMax, binary]);

  const x = (i: number) => left + (n <= 1 ? 0 : (i / (n - 1)) * plotW);
  const y = (v: number) => top + plotH - (Math.min(v, ceil) / ceil) * plotH;

  const paths = useMemo(
    () =>
      series.map((s) => {
        let d = "";
        let pen = false;
        s.values.forEach((v, i) => {
          if (v === null) {
            pen = false;
            return;
          }
          d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
          pen = true;
        });
        return d;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, plotW, ceil],
  );

  const lastIdx = (s: Series) => {
    for (let i = s.values.length - 1; i >= 0; i--) if (s.values[i] !== null) return i;
    return -1;
  };

  const pick = (clientX: number) => {
    const box = wrapRef.current!.getBoundingClientRect();
    const rel = (clientX - box.left - left) / plotW;
    setHover(Math.max(0, Math.min(n - 1, Math.round(rel * (n - 1)))));
  };

  const xTicks = [300, 240, 180, 120, 60, 0].filter((s) => s < n);
  const single = series.length === 1;
  const tipLeft = hover !== null ? x(hover) : 0;
  const flip = tipLeft > width - 190;

  return (
    <div
      ref={wrapRef}
      className="relative outline-none focus-visible:rounded-lg focus-visible:ring-2 focus-visible:ring-primary"
      style={{ height }}
      tabIndex={0}
      role="img"
      aria-label={ariaLabel}
      onPointerMove={(e) => pick(e.clientX)}
      onPointerLeave={() => setHover(null)}
      onFocus={() => setHover(n - 1)}
      onBlur={() => setHover(null)}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? n - 1) - (e.shiftKey ? 10 : 1)));
        else if (e.key === "ArrowRight") setHover((h) => Math.min(n - 1, (h ?? n - 1) + (e.shiftKey ? 10 : 1)));
      }}
    >
      {width > 0 ? (
        <svg width={width} height={height} className="block overflow-visible">
          {/* Gridlines + y ticks */}
          {[0, 1, 2, 3, 4].map((k) => {
            const v = step * k;
            const yy = y(v);
            return (
              <g key={k}>
                <line x1={left} x2={left + plotW} y1={yy} y2={yy} stroke={k === 0 ? "var(--viz-axis)" : "var(--viz-grid)"} strokeWidth={1} shapeRendering="crispEdges" />
                <text x={left - 8} y={yy} dy="0.32em" textAnchor="end" className="fill-ink-3 text-[11px] tabular">
                  {axisFormat(v)}
                </text>
              </g>
            );
          })}
          {xTicks.map((s) => (
            <text key={s} x={x(n - 1 - s)} y={height - 6} textAnchor={s === 0 ? "end" : "middle"} className="fill-ink-3 text-[11px] tabular">
              {s === 0 ? "now" : `-${s / 60}m`}
            </text>
          ))}
          {/* Area wash for a lone series */}
          {single && paths[0] ? (
            <path d={`${paths[0]}L${x(lastIdx(series[0])).toFixed(1)},${y(0)}L${x(series[0].values.findIndex((v) => v !== null)).toFixed(1)},${y(0)}Z`} fill={series[0].color} opacity={0.1} />
          ) : null}
          {series.map((s, i) => (
            <path key={s.key} d={paths[i]} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {/* Ringed end-dots */}
          {hover === null
            ? series.map((s) => {
                const li = lastIdx(s);
                return li >= 0 ? <circle key={s.key} cx={x(li)} cy={y(s.values[li]!)} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} /> : null;
              })
            : null}
          {hover !== null ? (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={top} y2={top + plotH} stroke="var(--line-strong)" strokeWidth={1} shapeRendering="crispEdges" />
              {series.map((s) =>
                s.values[hover] !== null ? <circle key={s.key} cx={x(hover)} cy={y(s.values[hover]!)} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} /> : null,
              )}
            </g>
          ) : null}
        </svg>
      ) : null}
      {hover !== null ? (
        <div
          className="pointer-events-none absolute top-1 z-10 min-w-[150px] rounded-xl bg-surface px-3 py-2 shadow-e2 ring-1 ring-line"
          style={flip ? { right: width - tipLeft + 12 } : { left: tipLeft + 12 }}
        >
          <div className="mb-1 text-[11px] text-ink-3">{agoLabel(n - 1 - hover)}</div>
          {series.map((s) => (
            <div key={s.key} className="flex items-center gap-2 text-xs">
              <span className="h-0.5 w-3 rounded-full" style={{ background: s.color }} />
              <span className="font-semibold text-ink tabular">{s.values[hover] === null ? "—" : format(s.values[hover]!)}</span>
              <span className="text-ink-2">{s.label}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Legend with live values — the always-visible identity + value channel for ≥2 series. */
export function SeriesLegend({ series, format }: { series: Series[]; format: (v: number) => string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {series.map((s) => {
        const last = [...s.values].reverse().find((v) => v !== null) ?? null;
        return (
          <span key={s.key} className="flex items-center gap-1.5 text-xs">
            <span className="h-0.5 w-3.5 rounded-full" style={{ background: s.color }} />
            <span className="text-ink-2">{s.label}</span>
            <span className="font-semibold text-ink tabular">{last === null ? "—" : format(last)}</span>
          </span>
        );
      })}
    </div>
  );
}

/** Table twin of a time-series chart (last N seconds). */
export function SeriesTable({ series, format, rows = 15 }: { series: Series[]; format: (v: number) => string; rows?: number }) {
  const n = series[0]?.values.length ?? 0;
  return (
    <details className="group mt-2">
      <summary className="cursor-pointer select-none text-xs text-ink-3 hover:text-ink-2">View as table</summary>
      <table className="mt-2 w-full text-xs tabular">
        <thead>
          <tr className="text-ink-3">
            <th className="py-1 text-left font-normal">Time</th>
            {series.map((s) => (
              <th key={s.key} className="py-1 text-right font-normal">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: Math.min(rows, n) }, (_, k) => n - 1 - k).map((i) => (
            <tr key={i} className="border-t border-line">
              <td className="py-1 text-ink-2">{agoLabel(n - 1 - i)}</td>
              {series.map((s) => (
                <td key={s.key} className="py-1 text-right text-ink">
                  {s.values[i] === null ? "—" : format(s.values[i]!)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

/**
 * Stat-tile trend: de-emphasised line, current point in the accent.
 * `fluid` stretches it to its container's width (the dot is HTML so it stays round).
 */
export function Sparkline({ values, accent = "var(--series-1)", fluid = false }: { values: number[]; accent?: string; fluid?: boolean }) {
  const w = 96;
  const h = 28;
  const max = Math.max(1e-9, ...values);
  const pts = values.map((v, i) => [(i / Math.max(1, values.length - 1)) * (w - 6) + 1, h - 4 - (v / max) * (h - 8)] as const);
  const last = pts[pts.length - 1];
  if (fluid)
    return (
      <div className="relative h-7 w-full" aria-hidden>
        <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible">
          <polyline points={pts.map((p) => p.join(",")).join(" ")} fill="none" stroke="var(--ink-3)" strokeOpacity={0.6} strokeWidth={1.5} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </svg>
        {last ? (
          <span
            className="absolute size-[11px] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface"
            style={{ left: `${(last[0] / w) * 100}%`, top: `${(last[1] / h) * 100}%`, background: accent }}
          />
        ) : null}
      </div>
    );
  return (
    <svg width={w} height={h} className="overflow-visible" aria-hidden>
      <polyline points={pts.map((p) => p.join(",")).join(" ")} fill="none" stroke="var(--ink-3)" strokeOpacity={0.6} strokeWidth={1.5} strokeLinejoin="round" />
      {last ? <circle cx={last[0]} cy={last[1]} r={3.5} fill={accent} stroke="var(--surface)" strokeWidth={2} /> : null}
    </svg>
  );
}

/** Ratio against a limit: same-ramp track, accent fill. */
export function Meter({ value, label, detail }: { value: number; label: string; detail: ReactNode }) {
  const pct = Math.max(0, Math.min(1, value));
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3 text-sm">
        <span className="text-ink">{label}</span>
        <span className="text-xs text-ink-2 tabular">{detail}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full" style={{ background: "color-mix(in oklab, var(--series-1) 18%, var(--surface))" }}>
        <div className="h-full rounded-full bg-[var(--series-1)] transition-[width] duration-500" style={{ width: `${pct * 100}%` }} />
      </div>
    </div>
  );
}

/** Part-to-whole: one horizontal stacked bar with 2 px surface gaps, legend with values, hover tooltips. */
export function StackedBar({ segments, format }: { segments: { key: string; label: string; value: number; color: string }[]; format: (v: number) => string }) {
  const total = segments.reduce((a, s) => a + s.value, 0);
  const [hover, setHover] = useState<string | null>(null);
  const visible = segments.filter((s) => s.value > 0);
  return (
    <div>
      <div className="relative flex h-4 gap-[2px]" role="img" aria-label={segments.map((s) => `${s.label} ${format(s.value)}`).join(", ")}>
        {total === 0 ? <div className="h-full w-full rounded bg-surface-3" /> : null}
        {visible.map((s, i) => (
          <div
            key={s.key}
            onPointerEnter={() => setHover(s.key)}
            onPointerLeave={() => setHover(null)}
            className={cn("relative h-full min-w-[3px] transition-[filter]", i === 0 && "rounded-l", i === visible.length - 1 && "rounded-r", hover === s.key && "brightness-110")}
            style={{ flexGrow: s.value, flexBasis: 0, background: s.color }}
          >
            {hover === s.key ? (
              <div className="pointer-events-none absolute bottom-6 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-lg bg-surface px-2.5 py-1.5 text-xs shadow-e2 ring-1 ring-line">
                <span className="font-semibold text-ink">{format(s.value)}</span> <span className="text-ink-2">{s.label}</span>{" "}
                <span className="text-ink-3">({((s.value / total) * 100).toFixed(1)}%)</span>
              </div>
            ) : null}
          </div>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-3">
        {segments.map((s) => (
          <div key={s.key} className="flex items-center gap-2 text-xs">
            <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: s.color }} />
            <span className="text-ink-2">{s.label}</span>
            <span className="ml-auto font-medium text-ink tabular">{format(s.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
