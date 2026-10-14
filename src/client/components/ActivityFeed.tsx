"use client";
import { Copy, Download, Eye, Flame, FolderInput, FolderPlus, History, Inbox, Link2, Link2Off, Palette, Pencil, RotateCcw, Sparkles, Trash2, Upload, type LucideIcon } from "lucide-react";
import { formatAgo } from "@/lib/format";
import type { Activity } from "@/lib/types";
import { navigate } from "../router";
import { useUi } from "../store";
import { cn } from "./ui";

const others = (a: Activity, noun = "other") => (a.count > 1 ? ` and ${(a.count - 1).toLocaleString()} ${noun}${a.count - 1 === 1 ? "" : "s"}` : "");
const q = (s: string | null) => (s ? `“${s}”` : "an item");

/** One line of plain language per event, with the names that matter in bold. */
function describe(a: Activity): { icon: LucideIcon; tone: "ink" | "accent" | "danger" | "success" | "sky"; text: React.ReactNode } {
  const name = <b className="font-semibold text-ink">{q(a.name)}</b>;
  const folder = a.parentName ? (
    <>
      {" "}
      to <b className="font-semibold text-ink">{a.parentName === "My files" ? "My files" : a.parentName}</b>
    </>
  ) : null;
  switch (a.kind) {
    case "upload":
      return { icon: Upload, tone: "accent", text: <>Uploaded {name}{others(a, "file")}{folder}</> };
    case "duplicate":
      return {
        icon: Copy,
        tone: "sky",
        text: a.count > 1 ? <>{a.count.toLocaleString()} files were already there — nothing new uploaded</> : <>{name} was already there — nothing new uploaded</>,
      };
    case "folder":
      return { icon: FolderPlus, tone: "ink", text: <>Created folder {name}</> };
    case "rename":
      return { icon: Pencil, tone: "ink", text: <>Renamed {q((a.detail?.from as string) ?? null)} to {name}</> };
    case "move":
      return { icon: FolderInput, tone: "ink", text: <>Moved {name}{others(a)}{folder}</> };
    case "copy":
      return { icon: Copy, tone: "ink", text: <>Copied {name}{others(a)}{folder}</> };
    case "trash":
      return { icon: Trash2, tone: "danger", text: <>Moved {name}{others(a)} to trash</> };
    case "restore":
      return { icon: RotateCcw, tone: "success", text: <>Restored {name}{others(a)}</> };
    case "delete":
      return { icon: Flame, tone: "danger", text: <>Deleted {name}{others(a)} forever</> };
    case "purge":
      return { icon: Sparkles, tone: "ink", text: <>Trash cleanup deleted {a.count.toLocaleString()} old item{a.count === 1 ? "" : "s"}</> };
    case "share":
      return { icon: Link2, tone: "accent", text: <>Created a link for {name}{a.count > 1 ? ` (${a.count} items)` : ""}</> };
    case "unshare":
      return { icon: Link2Off, tone: "ink", text: <>Turned off the link for {name}</> };
    case "share_view":
      return { icon: Eye, tone: "sky", text: <>Your link {name} was opened{a.count > 1 ? ` ${a.count.toLocaleString()} times` : ""}</> };
    case "share_download":
      return { icon: Download, tone: "success", text: <>{name} was downloaded through your link{a.count > 1 ? ` · ${a.count.toLocaleString()}×` : ""}</> };
    case "version":
      return a.detail?.restored
        ? { icon: History, tone: "success", text: <>Restored an earlier version of {name}</> }
        : { icon: History, tone: "accent", text: <>Saved a new version of {name}{others(a, "file")}</> };
    case "color":
      return { icon: Palette, tone: "ink", text: <>Recoloured {name}{others(a)}</> };
    case "request":
      return { icon: Inbox, tone: "accent", text: <>Created the file request {name}</> };
    case "received":
      return {
        icon: Inbox,
        tone: "success",
        text: (
          <>
            Received {a.count.toLocaleString()} file{a.count === 1 ? "" : "s"} through {name}
            {typeof a.detail?.from === "string" && a.detail.from ? <> from {a.detail.from}</> : null}
          </>
        ),
      };
  }
}

const TONE = {
  ink: "bg-invert text-on-invert",
  accent: "bg-accent text-on-accent",
  danger: "bg-danger-soft text-danger",
  success: "bg-success-soft text-success",
  sky: "bg-sky-soft text-sky",
};

function go(a: Activity) {
  if (a.kind.startsWith("share") || a.kind === "unshare" || a.kind === "request") return navigate({ name: "shared" });
  if (a.kind === "delete" || a.kind === "purge") return;
  if (a.kind === "trash") return navigate({ name: "trash" });
  if (a.nodeId && a.nodeAlive) {
    useUi.getState().revealNode(a.nodeId);
    navigate({ name: "folder", id: a.parentId ?? "root" });
  } else if (a.parentId) navigate({ name: "folder", id: a.parentId });
}

export function ActivityList({ items, compact, onNavigate, emptyText = "Nothing has happened yet." }: { items: Activity[] | undefined; compact?: boolean; onNavigate?: () => void; emptyText?: string }) {
  if (!items) {
    return (
      <div className="space-y-3 p-1">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="flex items-center gap-3">
            <div className="skeleton size-8" />
            <div className="skeleton h-3 flex-1" />
          </div>
        ))}
      </div>
    );
  }
  if (!items.length) return <p className="px-1 py-6 text-center text-[14px] text-ink-3">{emptyText}</p>;
  return (
    <ul className="divide-y divide-line">
      {items.map((a, i) => {
        const d = describe(a);
        const Icon = d.icon;
        return (
          <li key={a.id} className="animate-rise" style={{ animationDelay: `${Math.min(i, 10) * 30}ms` }}>
            <button
              onClick={() => {
                go(a);
                onNavigate?.();
              }}
              className={cn("flex w-full items-start gap-3 text-left transition-colors hover:bg-surface-2", compact ? "px-3 py-2.5" : "px-2 py-3")}
            >
              <span className={cn("mt-0.5 flex size-8 shrink-0 items-center justify-center", TONE[d.tone])}>
                <Icon className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] leading-snug text-ink-2 [overflow-wrap:anywhere]">{d.text}</span>
                <span className="mt-0.5 block text-[12px] text-ink-3">{formatAgo(a.at)}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
