"use client";
import { toast } from "sonner";
import { create } from "zustand";
import type { DriveNode } from "@/lib/types";
import { sleep, waitOnline } from "../api";
import { fileUrl } from "../files";

/**
 * Fast downloads for big files.
 *
 * The browser's own download is one HTTP stream. Here a big file is fetched
 * as several byte ranges at once — each its own server stream with its own
 * readahead, so more Telegram connections work for you in parallel — and
 * written straight to disk at the right offsets through the File System
 * Access API. A dropped connection costs only the bytes of the segment in
 * flight: the segment resumes from where it stopped. While writing, the
 * bytes are hashed in order and checked against the file's SHA-256 (the
 * server's Repr-Digest header), so a finished download is proven identical.
 *
 * Where that API is missing (Firefox, Safari, plain-HTTP LAN), or for small
 * files, the browser's own download manager takes over.
 */

const MIN_SIZE = 24 * 1024 * 1024;
const SEGMENT = 16 * 1024 * 1024;
const PARALLEL = 4;
const MAX_ATTEMPTS = 10;

export type DownloadStatus = "preparing" | "downloading" | "verifying" | "done" | "error" | "canceled";

export interface DownloadItem {
  id: number;
  name: string;
  size: number;
  mime: string | null;
  loaded: number;
  speed: number;
  status: DownloadStatus;
  /** True once the whole-file SHA-256 matched. */
  verified?: boolean;
  error?: string;
  note?: string;
  startedAt: number;
  finishedAt?: number;
}

interface DownloadsState {
  items: DownloadItem[];
  clearFinished: () => void;
}

export const useDownloads = create<DownloadsState>()((set) => ({
  items: [],
  clearFinished: () => set((s) => ({ items: s.items.filter((i) => i.status === "preparing" || i.status === "downloading" || i.status === "verifying") })),
}));

const controllers = new Map<number, AbortController>();
let seq = 1;

const patch = (id: number, p: Partial<DownloadItem>) => useDownloads.setState((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, ...p } : i)) }));

type Writable = {
  write(chunk: { type: "write"; position: number; data: Uint8Array }): Promise<void>;
  truncate(size: number): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
};
type SavePicker = (opts: { suggestedName: string }) => Promise<{ createWritable(): Promise<Writable> }>;

/** Can this browser write a file at arbitrary offsets? */
export const canFastDownload = () => typeof window !== "undefined" && window.isSecureContext && typeof (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker === "function";

/** Whether a file is worth a parallel download (and the browser can do one). */
export const wantsFastDownload = (node: Pick<DriveNode, "kind" | "size">) => node.kind === "file" && node.size >= MIN_SIZE && canFastDownload();

const b64ToHex = (b64: string) => Array.from(atob(b64), (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");

/**
 * Downloads one file in parallel segments. Must be called from a click (the
 * save dialog needs a user gesture). Returns false if the caller should fall
 * back to a normal download.
 */
export async function fastDownload(node: DriveNode): Promise<boolean> {
  if (!wantsFastDownload(node)) return false;
  let handle: Awaited<ReturnType<SavePicker>>;
  try {
    handle = await (window as unknown as { showSaveFilePicker: SavePicker }).showSaveFilePicker({ suggestedName: node.name });
  } catch (e) {
    // Closing the save dialog is an answer, not a failure.
    if ((e as DOMException).name === "AbortError") return true;
    return false;
  }
  const id = seq++;
  const ctrl = new AbortController();
  controllers.set(id, ctrl);
  useDownloads.setState((s) => ({
    items: [...s.items, { id, name: node.name, size: node.size, mime: node.mime, loaded: 0, speed: 0, status: "preparing", startedAt: Date.now() }],
  }));
  void run(id, node, handle, ctrl.signal);
  return true;
}

async function run(id: number, node: DriveNode, handle: Awaited<ReturnType<SavePicker>>, signal: AbortSignal) {
  let writable: Writable | null = null;
  try {
    writable = await handle.createWritable();
    await writable.truncate(node.size);
    const url = fileUrl(node, true);
    const size = node.size;
    const segments = Array.from({ length: Math.ceil(size / SEGMENT) }, (_, i) => ({ start: i * SEGMENT, end: Math.min(size, (i + 1) * SEGMENT) - 1 }));

    // In-order hashing: segments finish out of order, so later ones wait (in
    // memory, at most a few) until the bytes before them have been hashed.
    const { createSHA256 } = await import("hash-wasm");
    const hasher = await createSHA256();
    hasher.init();
    let hashedTo = 0;
    const parked = new Map<number, Uint8Array[]>(); // segment start → its bytes, until it's its turn
    let expected: string | null = null;

    const feed = () => {
      for (let next = parked.get(hashedTo); next; next = parked.get(hashedTo)) {
        parked.delete(hashedTo);
        for (const chunk of next) {
          hasher.update(chunk);
          hashedTo += chunk.length;
        }
      }
    };

    let loaded = 0;
    let sample = { t: performance.now(), bytes: 0, speed: 0 };
    const tick = setInterval(() => {
      const now = performance.now();
      const inst = ((loaded - sample.bytes) / (now - sample.t)) * 1000;
      sample = { t: now, bytes: loaded, speed: sample.speed ? sample.speed * 0.7 + inst * 0.3 : inst };
      patch(id, { loaded, speed: sample.speed });
    }, 500);

    patch(id, { status: "downloading" });
    let cursor = 0;
    // Backpressure: never run more than 8 segments (128 MiB) ahead of the
    // hash cursor, so one stalled segment can't make memory grow unbounded.
    const ahead = () => cursor < segments.length && segments[cursor].start - hashedTo > SEGMENT * PARALLEL * 2;
    const worker = async () => {
      while (cursor < segments.length) {
        while (ahead() && !signal.aborted) await sleep(100).catch(() => {});
        if (cursor >= segments.length) break;
        const seg = segments[cursor++];
        const chunks: Uint8Array[] = [];
        let pos = seg.start;
        for (let attempt = 1; ; attempt++) {
          if (signal.aborted) throw new DOMException("Aborted", "AbortError");
          try {
            const res = await fetch(url, { headers: { Range: `bytes=${pos}-${seg.end}` }, signal, cache: "no-store" });
            if (res.status !== 206) throw new Error(res.status === 200 ? "The server ignored the byte range" : `HTTP ${res.status}`);
            const digest = /sha-256=:([A-Za-z0-9+/=]+):/.exec(res.headers.get("repr-digest") ?? "")?.[1];
            if (digest) expected ??= b64ToHex(digest);
            const reader = res.body!.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              await writable!.write({ type: "write", position: pos, data: value });
              chunks.push(value);
              pos += value.length;
              loaded += value.length;
            }
            if (pos !== seg.end + 1) throw new Error("Connection closed early");
            break;
          } catch (e) {
            if (signal.aborted || (e as DOMException).name === "AbortError") throw e;
            if (attempt >= MAX_ATTEMPTS) throw e;
            patch(id, { note: navigator.onLine ? "Connection hiccup — resuming" : "Offline — waiting for network" });
            await waitOnline();
            await sleep(Math.min(15_000, 300 * 2 ** attempt * Math.random() + 200), signal);
            patch(id, { note: undefined });
          }
        }
        parked.set(seg.start, chunks);
        feed();
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(PARALLEL, segments.length) }, worker));
    } finally {
      clearInterval(tick);
    }

    patch(id, { status: "verifying", loaded: size, speed: 0, note: undefined });
    feed();
    const actual = hasher.digest("hex");
    if (hashedTo !== size || (expected && actual !== expected)) throw new Error("Checksum mismatch — the download was discarded");
    await writable.close();
    writable = null;
    patch(id, { status: "done", verified: Boolean(expected), finishedAt: Date.now() });
    toast.success(`${node.name} downloaded`, { description: expected ? "Checksum verified." : undefined });
  } catch (e) {
    const canceled = signal.aborted || (e as DOMException).name === "AbortError";
    patch(id, { status: canceled ? "canceled" : "error", error: canceled ? undefined : (e as Error).message, speed: 0, note: undefined });
    // Nothing half-written is left behind.
    await writable?.abort().catch(() => {});
  } finally {
    controllers.delete(id);
  }
}

export function cancelDownload(id: number) {
  controllers.get(id)?.abort();
}
