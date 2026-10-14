"use client";
import { ArrowUp, Check, Clock, FileUp, HardDrive, Lock, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatBytes, formatFullDate } from "@/lib/format";
import { api, ApiError } from "../api";
import { cancelVisitorUpload, sendFiles, useVisitorUploads, type VisitorItem } from "../upload/visitor";
import { GeoStrip, Logo } from "./Brand";
import { TypeIcon } from "./NodeVisual";
import { Gone, Locked } from "./SharePage";
import { Button, cn, Spinner, TextField } from "./ui";

interface RequestInfo {
  title: string;
  note: string | null;
  maxBytes: number | null;
  expiresAt: number | null;
  hasPassword: boolean;
}

type State = { kind: "loading" } | { kind: "ok"; info: RequestInfo } | { kind: "locked"; title: string } | { kind: "gone"; message: string; reason?: string };

/** The page someone opens from a file request link: send files, see nothing else. */
export function RequestPage() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<State>({ kind: "loading" });
  const fetchState = useCallback(async (): Promise<State> => {
    try {
      return { kind: "ok", info: await api<RequestInfo>(`/api/public/${token}/request`) };
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { passwordRequired?: boolean; title?: string; reason?: string }) : null;
      if (body?.passwordRequired) return { kind: "locked", title: body.title ?? "File request" };
      return { kind: "gone", message: e instanceof ApiError ? e.message : "Could not open this link", reason: body?.reason };
    }
  }, [token]);
  useEffect(() => {
    let cancelled = false;
    void fetchState().then((s) => !cancelled && setState(s));
    return () => {
      cancelled = true;
    };
  }, [fetchState]);

  if (state.kind === "loading") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-canvas">
        <Spinner className="size-8" />
      </div>
    );
  }
  if (state.kind === "locked") return <Locked token={token} title={state.title} onUnlocked={() => void fetchState().then(setState)} />;
  if (state.kind === "gone") return <Gone message={state.message} reason={state.reason} />;
  return <Collect token={token} info={state.info} />;
}

function Collect({ token, info }: { token: string; info: RequestInfo }) {
  const items = useVisitorUploads((s) => s.items);
  const [from, setFrom] = useState("");
  const [dragging, setDragging] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const take = useCallback(
    (files: File[]) => {
      if (!files.length) return;
      const tooBig = info.maxBytes ? files.filter((f) => f.size > info.maxBytes!) : [];
      setRefused(tooBig.length ? `${tooBig.map((f) => f.name).join(", ")} ${tooBig.length === 1 ? "is" : "are"} over the ${formatBytes(info.maxBytes!)} limit` : null);
      const ok = files.filter((f) => !tooBig.includes(f));
      if (ok.length) sendFiles(token, ok, from.trim() || null);
    },
    [from, info.maxBytes, token],
  );

  // Drop files anywhere on the page.
  useEffect(() => {
    let depth = 0;
    const has = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const enter = (e: DragEvent) => {
      if (!has(e)) return;
      depth++;
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!has(e)) return;
      if (--depth <= 0) setDragging(false);
    };
    const over = (e: DragEvent) => {
      if (has(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!has(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      take(Array.from(e.dataTransfer?.files ?? []));
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [take]);

  const active = items.filter((i) => i.status === "queued" || i.status === "uploading" || i.status === "verifying").length;
  const done = items.filter((i) => i.status === "done").length;

  return (
    <div className="min-h-dvh bg-canvas" data-testid="request-page">
      <GeoStrip className="h-12 md:h-16" />
      <main className="mx-auto max-w-3xl px-4 pb-20 pt-8 md:pt-12">
        <div className="flex items-center justify-between">
          <Logo />
          <span className="label bg-accent px-2 py-1 text-on-accent">File request</span>
        </div>
        <h1 className="mt-10 text-[36px] font-semibold leading-[1.02] tracking-[-0.035em] text-ink animate-rise md:text-[56px]">{info.title}</h1>
        {info.note ? (
          <p className="mt-5 border-l-[3px] border-accent bg-surface px-4 py-3 text-[15.5px] leading-relaxed text-ink animate-rise [animation-delay:80ms]" data-testid="request-note">
            {info.note}
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5 text-[13px] text-ink-3 animate-rise [animation-delay:120ms]">
          <span className="inline-flex items-center gap-1.5">
            <Lock className="size-3.5" /> Only the owner sees what you send
          </span>
          {info.maxBytes ? (
            <span className="inline-flex items-center gap-1.5">
              <HardDrive className="size-3.5" /> Up to {formatBytes(info.maxBytes)} per file
            </span>
          ) : null}
          {info.expiresAt ? (
            <span className="inline-flex items-center gap-1.5">
              <Clock className="size-3.5" /> Open until {formatFullDate(info.expiresAt)}
            </span>
          ) : null}
        </div>

        <div className="mt-8 grid gap-4 md:grid-cols-[1fr_260px]">
          <button
            type="button"
            onClick={() => input.current?.click()}
            className={cn(
              "lift group relative flex min-h-[260px] flex-col items-center justify-center gap-4 overflow-hidden border-[1.5px] border-dashed border-line-strong bg-surface p-8 text-center transition-colors",
              dragging && "border-solid border-accent bg-accent-soft",
            )}
            data-testid="request-drop"
          >
            {/* A small Bauhaus composition: the sun rises, the arrow lifts. */}
            <span className="relative flex size-28 items-center justify-center" aria-hidden>
              <span className="absolute inset-0 rounded-full bg-accent transition-transform duration-500 group-hover:scale-105" />
              <span className="absolute -bottom-1 left-1/2 h-1/2 w-[130%] -translate-x-1/2 bg-surface [clip-path:polygon(0_40%,100%_40%,100%_100%,0_100%)]" />
              <span className="relative -mt-4 flex size-14 items-center justify-center bg-invert text-on-invert transition-transform duration-300 group-hover:-translate-y-1.5">
                <ArrowUp className="size-7" strokeWidth={2.5} />
              </span>
            </span>
            <span>
              <span className="block text-[20px] font-semibold tracking-[-0.02em] text-ink">{dragging ? "Drop to send" : "Drop files here"}</span>
              <span className="mt-1 block text-[14px] text-ink-3">or click to choose them — any type, any size{info.maxBytes ? ` up to ${formatBytes(info.maxBytes)}` : ""}</span>
            </span>
            <input
              ref={input}
              type="file"
              multiple
              hidden
              data-testid="request-input"
              onChange={(e) => {
                take(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
          </button>
          <div className="border-[1.5px] border-line-strong bg-surface p-5">
            <TextField label="Your name (optional)" placeholder="So they know who sent it" value={from} maxLength={80} onChange={(e) => setFrom(e.target.value)} />
            <Button className="mt-4 w-full" size="lg" onClick={() => input.current?.click()}>
              <FileUp className="size-4" /> Choose files
            </Button>
            <p className="mt-3 text-[12.5px] leading-snug text-ink-3">Every file is checked with SHA-256 on the way. A dropped connection resumes without starting over.</p>
          </div>
        </div>
        {refused ? <p className="mt-3 bg-danger-soft px-4 py-3 text-[14px] font-medium text-danger">{refused}</p> : null}

        {items.length ? (
          <section className="mt-8 border-[1.5px] border-line-strong bg-surface" data-testid="request-uploads">
            <div className="flex items-center justify-between bg-invert px-4 py-3 text-on-invert">
              <span className="text-[15px] font-semibold">{active ? `Sending ${active} file${active === 1 ? "" : "s"}…` : `${done} file${done === 1 ? "" : "s"} sent`}</span>
              {!active && done ? (
                <span className="inline-flex items-center gap-1.5 text-[13px] text-on-invert/75">
                  <Check className="size-4" /> Delivered and verified
                </span>
              ) : null}
            </div>
            <ul>
              <AnimatePresence initial={false}>
                {[...items].reverse().map((it) => (
                  <motion.li key={it.id} layout initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                    <Row item={it} />
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          </section>
        ) : null}
      </main>
    </div>
  );
}

function Row({ item }: { item: VisitorItem }) {
  const active = item.status === "uploading" || item.status === "verifying" || item.status === "queued";
  const pct = item.size ? Math.min(1, item.loaded / item.size) : 1;
  const detail =
    item.status === "queued"
      ? "Waiting…"
      : item.status === "uploading"
        ? `${formatBytes(item.loaded)} of ${formatBytes(item.size)}`
        : item.status === "verifying"
          ? "Checking the SHA-256…"
          : item.status === "done"
            ? `${formatBytes(item.size)} · delivered`
            : item.status === "canceled"
              ? "Cancelled"
              : (item.error ?? "Failed");
  return (
    <div className="relative flex items-center gap-3 border-t border-line px-4 py-3" data-testid="request-row" data-status={item.status}>
      <TypeIcon node={{ kind: "file", name: item.name, mime: item.type }} className="size-9" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14.5px] font-semibold text-ink">{item.name}</div>
        <div className={cn("truncate text-[12.5px] tabular", item.status === "error" ? "font-medium text-danger" : "text-ink-3")}>{detail}</div>
      </div>
      {item.status === "done" ? (
        <span className="flex size-6 items-center justify-center bg-success text-white">
          <Check className="size-4" strokeWidth={3} />
        </span>
      ) : active ? (
        <button aria-label={`Cancel ${item.name}`} onClick={() => cancelVisitorUpload(item.id)} className="flex size-8 items-center justify-center text-ink-3 hover:bg-surface-3 hover:text-ink">
          <X className="size-4" />
        </button>
      ) : null}
      {active ? (
        <span className="absolute inset-x-0 bottom-0 h-[3px] bg-surface-3">
          <span className={cn("block h-full transition-[width] duration-300", item.status === "verifying" ? "bg-sky" : "bg-accent")} style={{ width: `${Math.max(2, pct * 100)}%` }} />
        </span>
      ) : null}
    </div>
  );
}
