const UNITS = ["B", "KB", "MB", "GB", "TB", "PB", "EB"];

export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  // Divide instead of taking log(bytes)/log(1024): the float log puts exact
  // powers like 2^60 one unit low ("1024 PB" instead of "1.0 EB").
  const fixed = (n: number, unit: number) => n.toFixed(unit === 0 || n >= 100 ? 0 : digits);
  let i = 0;
  let v = bytes;
  // The second test carries a value that rounds to 1024 ("1024 KB") into the next unit.
  while (i < UNITS.length - 1 && (v >= 1024 || Number(fixed(v, i)) >= 1024)) {
    v /= 1024;
    i++;
  }
  return `${fixed(v, i)} ${UNITS[i]}`;
}

export function formatRate(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${Math.floor(seconds % 60)}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const dateFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const fullFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Drive-style relative date: time today, "Mon D" this year, full date otherwise. */
export function formatDate(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return timeFmt.format(d);
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return dateFmt.format(d);
}

export function formatFullDate(ts: number): string {
  return fullFmt.format(new Date(ts));
}

export function formatAgo(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** "1 file", "2 files", "1,204 items". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat(undefined, { notation: n >= 100_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(n);
}
