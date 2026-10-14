"use client";
import { ArrowDown, Check, ChevronDown, Crosshair, Play, RotateCw, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useRef } from "react";
import { toast } from "sonner";
import { formatBytes, formatDuration, formatRate } from "@/lib/format";
import { navigate } from "../router";
import { usePrefs, useUi } from "../store";
import { cancelDownload, useDownloads, type DownloadItem, type DownloadStatus } from "../download/engine";
import { cancelAll, cancelUpload, discardUpload, resumeUpload, retryUpload, useUploads, type UploadItem, type UploadStatus } from "../upload/engine";
import { TypeIcon } from "./NodeVisual";
import { cn } from "./ui";

const MAX_ROWS = 200;
const ACTIVE: ReadonlySet<UploadStatus> = new Set(["queued", "uploading", "holding", "verifying"]);

/** One plain sentence per upload. */
function detail(it: UploadItem): string {
  switch (it.status) {
    case "queued":
      return `${formatBytes(it.size)} · waiting`;
    case "uploading":
      return `${formatBytes(it.loaded)} of ${formatBytes(it.size)}${it.speed > 0 ? ` · ${formatRate(it.speed)}` : ""}${it.note ? ` · ${it.note}` : it.resumed ? " · continued" : ""}`;
    case "holding":
      return it.note ?? "Waiting to continue";
    case "verifying":
      return it.note ?? "Verifying checksums";
    case "done":
      if (it.outcome === "renamed") return `Saved as “${it.finalName}” — the name was taken`;
      if (it.outcome === "replaced") return "Replaced the old version (it's in the trash)";
      return `${formatBytes(it.size)} · uploaded and verified`;
    case "deduped":
      if (it.outcome === "renamed") return `Already stored — linked instantly as “${it.finalName}”`;
      return "Already in your storage — linked instantly, nothing re-uploaded";
    case "exists":
      return "Already in this folder — nothing new uploaded";
    case "skipped":
      return "Skipped — a file with this name exists";
    case "canceled":
      return "Cancelled";
    case "error":
      return it.error ? `${it.error} — Retry continues where it stopped` : "Upload failed";
    case "interrupted":
      return `Paused at ${formatBytes(it.loaded)} of ${formatBytes(it.size)}. Pick the file again to continue.`;
  }
}

/** Continues an interrupted upload: after a reload the browser needs the file picked again. */
function ResumeButtons({ item }: { item: UploadItem }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file && !resumeUpload(item.id, file)) toast.error(`That's a different file — pick “${item.name}” (${formatBytes(item.size)})`);
        }}
      />
      <button
        aria-label={`Resume ${item.name}`}
        onClick={() => input.current?.click()}
        className="flex h-8 items-center gap-1 px-2 text-[12.5px] font-semibold text-accent transition hover:bg-surface-3"
      >
        <Play className="size-3.5 fill-current" /> Resume
      </button>
      <button aria-label={`Discard ${item.name}`} onClick={() => discardUpload(item.id)} className="flex size-8 items-center justify-center text-ink-3 transition hover:bg-surface-3 hover:text-ink">
        <X className="size-4" />
      </button>
    </>
  );
}

function StatusMark({ it }: { it: UploadItem }) {
  if (it.status === "done" || it.status === "deduped") {
    return (
      <span className="flex size-6 items-center justify-center bg-success text-white dark:text-[#06140d]">
        <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden>
          <path d="m5 12.5 4.5 4.5L19 7.5" strokeDasharray="24" style={{ animation: "draw 360ms var(--ease-out) both" }} />
        </svg>
      </span>
    );
  }
  if (it.status === "exists" || it.status === "skipped") return <span className="flex size-6 items-center justify-center bg-sky-soft text-[13px] font-bold text-sky">=</span>;
  return null;
}

function Row({ item }: { item: UploadItem }) {
  const active = ACTIVE.has(item.status);
  const progress = item.size ? item.loaded / item.size : 0;
  const landed = (item.status === "done" || item.status === "deduped" || item.status === "exists") && item.nodeId;
  return (
    <div className="group relative border-b border-line last:border-b-0" data-testid="upload-row" data-status={item.status} data-outcome={item.outcome ?? ""} data-resumed={item.resumed ? "true" : undefined}>
      <div className="flex items-center gap-3 px-4 py-3">
        <TypeIcon node={{ kind: "file", name: item.name, mime: null }} className="size-9" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold text-ink">{item.name}</div>
          <div className={cn("mt-0.5 text-[12.5px] tabular", item.status === "interrupted" || item.status === "error" ? "leading-snug" : "truncate", item.status === "error" ? "font-medium text-danger" : item.status === "exists" || item.status === "deduped" ? "text-sky" : "text-ink-3")}>
            {detail(item)}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <StatusMark it={item} />
          {item.status === "interrupted" ? (
            <ResumeButtons item={item} />
          ) : active ? (
            <button aria-label={`Cancel ${item.name}`} onClick={() => cancelUpload(item.id)} className="flex size-8 items-center justify-center text-ink-3 transition hover:bg-surface-3 hover:text-ink [@media(pointer:fine)]:opacity-0 [@media(pointer:fine)]:group-hover:opacity-100">
              <X className="size-4" />
            </button>
          ) : item.status === "error" || item.status === "canceled" ? (
            <button aria-label={`Retry ${item.name}`} onClick={() => retryUpload(item.id)} className="flex size-8 items-center justify-center text-ink-3 transition hover:bg-surface-3 hover:text-accent">
              <RotateCw className="size-4" />
            </button>
          ) : landed ? (
            <button
              aria-label={`Show ${item.name}`}
              onClick={() => {
                useUi.getState().revealNode(item.nodeId!);
                navigate({ name: "folder", id: item.parentId });
              }}
              className="flex size-8 items-center justify-center text-ink-3 transition hover:bg-surface-3 hover:text-accent"
            >
              <Crosshair className="size-4" />
            </button>
          ) : null}
        </div>
      </div>
      {(active && item.status !== "queued") || item.status === "interrupted" ? (
        <div className="absolute inset-x-0 bottom-0 h-[3px] bg-surface-3">
          <div
            className={cn(
              "h-full transition-[width] duration-300 ease-out",
              item.status === "holding" || item.status === "interrupted" ? "bg-warning" : item.status === "verifying" ? "bg-sky" : "bg-accent",
            )}
            style={{ width: `${Math.max(0.02, Math.min(1, progress)) * 100}%` }}
          />
        </div>
      ) : null}
    </div>
  );
}

const DOWNLOADING: ReadonlySet<DownloadStatus> = new Set(["preparing", "downloading", "verifying"]);

function downloadDetail(d: DownloadItem): string {
  switch (d.status) {
    case "preparing":
      return "Starting…";
    case "downloading":
      return `${formatBytes(d.loaded)} of ${formatBytes(d.size)}${d.speed > 0 ? ` · ${formatRate(d.speed)}` : ""}${d.note ? ` · ${d.note}` : " · 4 parallel streams"}`;
    case "verifying":
      return "Checking the SHA-256…";
    case "done":
      return `${formatBytes(d.size)} · saved${d.verified ? ", checksum verified" : ""}`;
    case "canceled":
      return "Cancelled — nothing was kept";
    case "error":
      return d.error ?? "Download failed";
  }
}

function DownloadRow({ item }: { item: DownloadItem }) {
  const active = DOWNLOADING.has(item.status);
  return (
    <div className="group relative border-b border-line last:border-b-0" data-testid="download-row" data-status={item.status}>
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="relative">
          <TypeIcon node={{ kind: "file", name: item.name, mime: item.mime }} className="size-9" />
          <span className="absolute -bottom-1 -right-1 flex size-4 items-center justify-center bg-invert text-on-invert">
            <ArrowDown className="size-3" strokeWidth={3} />
          </span>
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold text-ink">{item.name}</div>
          <div className={cn("mt-0.5 truncate text-[12.5px] tabular", item.status === "error" ? "font-medium text-danger" : "text-ink-3")}>{downloadDetail(item)}</div>
        </div>
        {item.status === "done" ? (
          <span className="flex size-6 items-center justify-center bg-success text-white dark:text-[#06140d]">
            <Check className="size-4" strokeWidth={3} />
          </span>
        ) : active ? (
          <button aria-label={`Cancel download of ${item.name}`} onClick={() => cancelDownload(item.id)} className="flex size-8 items-center justify-center text-ink-3 transition hover:bg-surface-3 hover:text-ink">
            <X className="size-4" />
          </button>
        ) : null}
      </div>
      {active ? (
        <div className="absolute inset-x-0 bottom-0 h-[3px] bg-surface-3">
          <div className={cn("h-full transition-[width] duration-300 ease-out", item.status === "verifying" ? "bg-sky" : "bg-invert")} style={{ width: `${Math.max(0.02, Math.min(1, item.size ? item.loaded / item.size : 0)) * 100}%` }} />
        </div>
      ) : null}
    </div>
  );
}

export function UploadPanel() {
  const items = useUploads((s) => s.items);
  const downloads = useDownloads((s) => s.items);
  const uploadsOpen = useUploads((s) => s.panelOpen);
  const collapsed = useUploads((s) => s.collapsed);
  const paused = useUploads((s) => s.paused);
  const setCollapsed = useUploads((s) => s.setCollapsed);
  const closeUploads = useUploads((s) => s.closePanel);
  const detailsOpen = usePrefs((s) => s.detailsOpen);
  const panelOpen = uploadsOpen || downloads.length > 0;
  const dl = useMemo(() => {
    const active = downloads.filter((d) => DOWNLOADING.has(d.status));
    const total = active.reduce((n, d) => n + d.size, 0);
    const loaded = active.reduce((n, d) => n + d.loaded, 0);
    return { active: active.length, total, loaded, speed: active.reduce((n, d) => n + d.speed, 0) };
  }, [downloads]);
  const closePanel = () => {
    closeUploads();
    useDownloads.getState().clearFinished();
    if (dl.active) setCollapsed(true);
  };

  const stats = useMemo(() => {
    let total = 0;
    let loaded = 0;
    let speed = 0;
    let active = 0;
    let failed = 0;
    let done = 0;
    let existing = 0;
    let saved = 0;
    let paused = 0;
    for (const i of items) {
      if (i.status === "interrupted") paused++;
      if (i.status === "canceled" || i.status === "skipped" || i.status === "interrupted") continue;
      total += i.size;
      loaded += ACTIVE.has(i.status) ? i.loaded : i.size;
      speed += i.status === "uploading" || i.status === "holding" ? i.speed : 0;
      if (ACTIVE.has(i.status)) active++;
      if (i.status === "error") failed++;
      if (i.status === "done" || i.status === "deduped") done++;
      if (i.status === "exists") existing++;
      if (i.status === "deduped" || i.status === "exists") saved += i.size;
    }
    return { total, loaded, speed, active, failed, done, existing, saved, paused };
  }, [items]);

  // In progress and failed first, then the newest results; at most MAX_ROWS rows for 10k-file batches.
  const ordered = useMemo(() => {
    const rank = (s: UploadStatus) => (s === "uploading" || s === "verifying" || s === "holding" ? 0 : s === "error" || s === "interrupted" ? 1 : s === "queued" ? 2 : 3);
    return [...items].sort((a, b) => rank(a.status) - rank(b.status) || (rank(a.status) === 3 ? b.id - a.id : a.id - b.id));
  }, [items]);

  const eta = stats.speed > 0 ? (stats.total - stats.loaded) / stats.speed : Infinity;
  const pct = stats.total ? Math.floor((stats.loaded / stats.total) * 100) : 0;
  const dlPct = dl.total ? Math.floor((dl.loaded / dl.total) * 100) : 0;
  const dlEta = dl.speed > 0 ? (dl.total - dl.loaded) / dl.speed : Infinity;
  const headline = stats.active
    ? `Uploading ${stats.active} file${stats.active === 1 ? "" : "s"}${dl.active ? ` · downloading ${dl.active}` : ""}`
    : dl.active
      ? `Downloading ${dl.active} file${dl.active === 1 ? "" : "s"}`
      : !items.length && downloads.length
        ? `${downloads.length} download${downloads.length === 1 ? "" : "s"}`
        : stats.failed
      ? `${stats.failed} upload${stats.failed === 1 ? "" : "s"} failed`
      : stats.paused
        ? `${stats.paused} upload${stats.paused === 1 ? "" : "s"} waiting to continue`
        : `${stats.done + stats.existing} upload${stats.done + stats.existing === 1 ? "" : "s"} complete`;

  return (
    <AnimatePresence>
      {panelOpen ? (
        <motion.section
          role="region"
          aria-label="Transfers"
          data-testid="upload-panel"
          initial={{ y: 60, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 60, opacity: 0 }}
          transition={{ type: "spring", stiffness: 420, damping: 36 }}
          className={cn(
            "fixed inset-x-2 bottom-[76px] z-40 overflow-hidden border-[1.5px] border-line-strong bg-surface shadow-hard transition-[right] duration-200 sm:inset-x-auto sm:bottom-5 sm:right-5 sm:w-[420px] md:bottom-5",
            detailsOpen && "lg:right-[372px]", // keep the details panel visible
          )}
        >
          <div className="flex h-14 items-center gap-2 bg-invert pl-4 pr-1.5 text-on-invert">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[15px] font-semibold">{headline}</div>
              {stats.active ? (
                <div className="text-[12px] text-on-invert/70 tabular">
                  {pct}% · {formatRate(stats.speed)} · {paused ? "waiting for the server" : Number.isFinite(eta) ? `${formatDuration(eta)} left` : "starting…"}
                </div>
              ) : dl.active ? (
                <div className="text-[12px] text-on-invert/70 tabular">
                  {dlPct}% · {formatRate(dl.speed)} · {Number.isFinite(dlEta) ? `${formatDuration(dlEta)} left` : "starting…"}
                </div>
              ) : stats.paused ? (
                <div className="truncate text-[12px] text-on-invert/70">Finished parts are kept — nothing is sent twice</div>
              ) : stats.saved > 0 ? (
                <div className="text-[12px] text-on-invert/70">{formatBytes(stats.saved)} not re-uploaded — already stored</div>
              ) : null}
            </div>
            {stats.active ? (
              <button onClick={cancelAll} className="h-9 px-2.5 text-[13px] font-semibold text-accent hover:bg-on-invert/10">
                Cancel all
              </button>
            ) : null}
            <button aria-label={collapsed ? "Expand uploads" : "Collapse uploads"} onClick={() => setCollapsed(!collapsed)} className="flex size-10 items-center justify-center text-on-invert/75 hover:bg-on-invert/10 hover:text-on-invert">
              <ChevronDown className={cn("size-5 transition-transform", collapsed && "rotate-180")} />
            </button>
            <button aria-label="Close uploads" onClick={closePanel} className="flex size-10 items-center justify-center text-on-invert/75 hover:bg-on-invert/10 hover:text-on-invert">
              <X className="size-5" />
            </button>
          </div>
          {stats.active ? (
            <div className="h-1 bg-surface-3">
              <div className="h-full bg-accent transition-[width] duration-300" style={{ width: `${pct}%` }} />
            </div>
          ) : null}
          <AnimatePresence initial={false}>
            {!collapsed ? (
              <motion.div
                initial={{ height: 0 }}
                animate={{ height: "auto" }}
                exit={{ height: 0 }}
                transition={{ type: "spring", stiffness: 500, damping: 42 }}
                className="overflow-hidden"
              >
                <div className="max-h-[min(360px,45dvh)] overflow-y-auto">
                  {[...downloads].reverse().map((d) => (
                    <DownloadRow key={`d${d.id}`} item={d} />
                  ))}
                  {ordered.slice(0, MAX_ROWS).map((it) => (
                    <Row key={it.id} item={it} />
                  ))}
                  {ordered.length > MAX_ROWS ? <div className="px-4 py-3 text-[12.5px] text-ink-3">+ {(ordered.length - MAX_ROWS).toLocaleString()} more</div> : null}
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
          {!collapsed && !stats.active && !stats.paused && stats.done + stats.existing > 0 ? (
            <div className="flex items-center gap-2 border-t border-line px-4 py-2.5 text-[12.5px] text-ink-3">
              <Check className="size-4 text-success" /> Everything is stored and verified.
            </div>
          ) : null}
        </motion.section>
      ) : null}
    </AnimatePresence>
  );
}
