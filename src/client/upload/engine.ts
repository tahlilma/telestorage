"use client";
import { toast } from "sonner";
import { create } from "zustand";
import { DEFAULT_CHUNK_SIZE, PIECE_SIZE, partSizes, type CompleteRetry, type MissingRange } from "@/lib/protocol";
import type { ConflictPolicy, DriveNode, FolderListing, UploadInit, UploadOutcome } from "@/lib/types";
import { ApiError, api, apiRetry, del, randomKey, waitOnline } from "../api";
import { categoryOf, type FileCategory } from "../files";
import { useUi } from "../store";
import { contentDigest, fingerprint, partRoots, type Fingerprint } from "./hasher";
import { forgetUpload, rememberUpload, sameFile, savedUploads, type SavedUpload } from "./journal";
import { readTakenAt } from "./media-meta";
import type { Outcome } from "./limiter";
import { AdaptiveLimiter } from "./limiter";
import { makeThumbnail, uploadThumb } from "./thumbs";
import { putChunk } from "./transport";

/**
 * Client-side upload engine. Files of any size, as far as the browser can
 * read them: nothing below holds more than a few chunks of a file in memory.
 *
 *  ┌ init (idempotent) ─▶ server session {partSize, partsInFlight}
 *  │
 *  ├ hash worker: whole-file SHA-256 + one hash-tree root per part, in one
 *  │  streaming pass alongside the upload
 *  │
 *  ├ chunk planner: a sliding window of parts (two per bot), chunks
 *  │  round-robin inside it so every bot is busy, parts finishing in order
 *  │  so progress becomes durable as it goes; adaptive chunk size (2–16 MiB)
 *  │
 *  ├ global scheduler: round-robin across files (fairness), concurrency from
 *  │  an AIMD limiter fed by latency, 503 Retry-After and network errors
 *  │
 *  ├ transport: XHR PUT + Content-Digest (SHA-256); 422 → resend, 409 → resync
 *  │
 *  ├ dedup: as soon as the hash is known, ask the server to link existing bytes
 *  │
 *  ├ journal: the session is remembered (IndexedDB); after a reload, a crash or
 *  │  a failure, the same file continues where it stopped
 *  │
 *  └ complete: SHA-256 + part roots; 409 → resend only what's missing
 */

const MAX_ACTIVE_FILES = 6;
const MIN_CHUNK = 4 * PIECE_SIZE; // 2 MiB
const MAX_CHUNK = 32 * PIECE_SIZE; // 16 MiB
const MAX_TASK_ATTEMPTS = 14;

/**
 * done: stored. deduped: identical bytes were already stored elsewhere, so the
 * file was linked instantly. exists: the very same file is already in this
 * folder (nothing new was created). skipped: the name was taken and you chose
 * skip. interrupted: started on an earlier visit; continues once you pick the
 * file again.
 */
export type UploadStatus = "queued" | "uploading" | "holding" | "verifying" | "done" | "deduped" | "exists" | "skipped" | "error" | "canceled" | "interrupted";

export interface UploadItem {
  id: number;
  flight: string;
  name: string;
  size: number;
  parentId: string;
  destination: string;
  category: FileCategory;
  status: UploadStatus;
  loaded: number;
  hashed: number;
  speed: number;
  note?: string;
  error?: string;
  nodeId?: string;
  /** How the name worked out (renamed to "x (1).png", replaced the old file…). */
  outcome?: UploadOutcome;
  finalName?: string;
  /** Continued from an earlier session rather than started from zero. */
  resumed?: boolean;
  startedAt?: number;
  finishedAt?: number;
}

interface Task extends MissingRange {
  attempts: number;
  notBefore: number;
}

interface Job {
  id: number;
  file: File;
  /** What to do if the name is taken when the file lands. */
  policy: ConflictPolicy;
  /** The name is taken by a file of the same size: probably identical, so hash before sending bytes. */
  hashFirst: boolean;
  abort: AbortController;
  idemKey: string;
  /** Set before start() when continuing an existing session. */
  session?: UploadInit;
  fp?: Promise<Fingerprint>;
  fpPartSize?: number;
  fpCancel?: () => void;
  sizes: number[];
  cursors: number[];
  /** Parts open at once, and the lowest part that may still have work. */
  window: number;
  lowPart: number;
  rr: number;
  redo: Task[];
  /** Chunk requests on the wire: their byte span and how much of it has been sent. */
  inflight: Map<string, { range: MissingRange; loaded: number }>;
  completed: number;
  chunkSize: number;
  phase: "pending" | "starting" | "uploading" | "finishing" | "finished";
  lastSample: { t: number; bytes: number };
}

interface UploadsState {
  items: UploadItem[];
  panelOpen: boolean;
  collapsed: boolean;
  concurrency: number;
  paused: boolean;
  setCollapsed: (c: boolean) => void;
  closePanel: () => void;
}

export const useUploads = create<UploadsState>()((set) => ({
  items: [],
  panelOpen: false,
  collapsed: false,
  concurrency: 4,
  paused: false,
  setCollapsed: (collapsed) => set({ collapsed }),
  closePanel: () => {
    if (activeCount() > 0) return set({ collapsed: true });
    set({ panelOpen: false, items: [] });
    jobs.clear();
    // Still remembered: picking or dropping the same file again continues it.
    interrupted.clear();
  },
}));

const limiter = new AdaptiveLimiter(2, 8, 4);
limiter.onChange(() => useUploads.setState({ concurrency: Math.round(limiter.limit * 10) / 10, paused: limiter.paused }));

const jobs = new Map<number, Job>();
const waiting: number[] = [];
/** Uploads from an earlier visit, waiting for their file to be picked again. */
const interrupted = new Map<number, SavedUpload>();
let seq = 1;

// ---------------------------------------------------------------------------
// Store updates, batched (~8/s). A timer rather than rAF keeps background tabs live.
// ---------------------------------------------------------------------------
const pendingPatches = new Map<number, Partial<UploadItem>>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
function update(id: number, patch: Partial<UploadItem>) {
  pendingPatches.set(id, { ...pendingPatches.get(id), ...patch });
  flushTimer ??= setTimeout(flush, 120);
}
function flush() {
  flushTimer = null;
  if (!pendingPatches.size) return;
  const patches = new Map(pendingPatches);
  pendingPatches.clear();
  useUploads.setState((s) => ({ items: s.items.map((it) => (patches.has(it.id) ? { ...it, ...patches.get(it.id) } : it)) }));
}
const itemById = (id: number) => useUploads.getState().items.find((i) => i.id === id);
const activeCount = () => [...jobs.values()].filter((j) => j.phase !== "finished").length;
const sessionBusy = (session: string) => [...jobs.values()].some((j) => j.session?.id === session && j.phase !== "finished");

function progress(job: Job) {
  let inflight = 0;
  for (const v of job.inflight.values()) inflight += v.loaded;
  update(job.id, { loaded: Math.min(job.file.size, job.completed + inflight) });
}

// ---------------------------------------------------------------------------
// Chunk planning
// ---------------------------------------------------------------------------

/**
 * The parts chunks may come from right now: the first `window` parts that
 * still have bytes to send, retries pending or requests on the wire. Later
 * parts wait, so parts finish (and become durable posts) in order.
 */
function openParts(job: Job): number[] {
  const busy = new Set<number>();
  for (const t of job.redo) busy.add(t.part);
  for (const v of job.inflight.values()) busy.add(v.range.part);
  const open: number[] = [];
  for (let p = job.lowPart; p < job.sizes.length && open.length < job.window; p++) {
    if (job.cursors[p] < job.sizes[p] || busy.has(p)) open.push(p);
    else if (p === job.lowPart) job.lowPart++;
  }
  return open;
}

function takeTask(job: Job): Task | null {
  const open = openParts(job);
  if (!open.length) return null;
  const now = Date.now();
  // Retries first. A range from a resume can be long: cut a request-sized slice off it.
  const i = job.redo.findIndex((t) => t.notBefore <= now && open.includes(t.part));
  if (i >= 0) {
    const t = job.redo[i];
    if (t.length <= job.chunkSize) return job.redo.splice(i, 1)[0];
    job.redo[i] = { ...t, offset: t.offset + job.chunkSize, length: t.length - job.chunkSize };
    return { ...t, length: job.chunkSize };
  }
  // New bytes, round-robin across the open parts → every bot progresses together.
  for (let k = 0; k < open.length; k++) {
    const p = open[(job.rr + k) % open.length];
    if (job.cursors[p] < job.sizes[p]) {
      const offset = job.cursors[p];
      const length = Math.min(job.chunkSize, job.sizes[p] - offset);
      job.cursors[p] += length;
      job.rr = job.rr + k + 1;
      return { part: p, offset, length, attempts: 0, notBefore: 0 };
    }
  }
  return null;
}

const isFinished = (job: Job) => job.phase === "finished";
const hasWork = (job: Job) => job.redo.length > 0 || job.cursors.some((c, p) => c < job.sizes[p]);
const keyOf = (t: MissingRange) => `${t.part}:${t.offset}`;

/**
 * `r` minus every chunk of the same part that is already on the wire. Those
 * either land or are re-queued by their own failure path, so sending their
 * bytes again would only duplicate work (and race the original request).
 */
function subtractInflight(job: Job, r: MissingRange): MissingRange[] {
  let out: MissingRange[] = [r];
  for (const { range: f } of job.inflight.values()) {
    if (f.part !== r.part) continue;
    const fEnd = f.offset + f.length;
    out = out.flatMap((p) => {
      const pEnd = p.offset + p.length;
      if (fEnd <= p.offset || f.offset >= pEnd) return [p];
      const left = f.offset > p.offset ? [{ part: p.part, offset: p.offset, length: f.offset - p.offset }] : [];
      const right = fEnd < pEnd ? [{ part: p.part, offset: fEnd, length: pEnd - fEnd }] : [];
      return [...left, ...right];
    });
  }
  return out;
}

/** Adjacent ranges of the same part, merged. */
function mergeRanges(ranges: MissingRange[]): MissingRange[] {
  const sorted = [...ranges].sort((a, b) => a.part - b.part || a.offset - b.offset);
  const out: MissingRange[] = [];
  for (const r of sorted) {
    const last = out.at(-1);
    if (last && last.part === r.part && last.offset + last.length === r.offset) last.length += r.length;
    else out.push({ ...r });
  }
  return out;
}

/**
 * Replaces the plan with exactly the ranges the server says it still needs.
 * Parts missing entirely are planned like fresh ones; the rest become retries.
 */
function resync(job: Job, missing: MissingRange[]) {
  const ranges = mergeRanges(missing);
  const onWire = new Set([...job.inflight.values()].map((v) => v.range.part));
  const whole = new Set(ranges.filter((m) => m.offset === 0 && m.length === job.sizes[m.part] && !onWire.has(m.part)).map((m) => m.part));
  job.cursors = job.sizes.map((s, p) => (whole.has(p) ? 0 : s));
  job.redo = ranges
    .filter((m) => !whole.has(m.part))
    .flatMap((m) => subtractInflight(job, m))
    .map((m) => ({ ...m, attempts: 0, notBefore: 0 }));
  job.lowPart = 0;
  job.completed = job.file.size - ranges.reduce((n, m) => n + m.length, 0);
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

let rr = 0;
let wakeTimer: ReturnType<typeof setTimeout> | null = null;

function pump() {
  // Admit new files.
  while (waiting.length && [...jobs.values()].filter((j) => j.phase === "starting" || j.phase === "uploading").length < MAX_ACTIVE_FILES) {
    const job = jobs.get(waiting.shift()!);
    if (job && job.phase === "pending") void start(job);
  }
  // Dispatch chunk tasks round-robin across uploading files.
  const uploading = [...jobs.values()].filter((j) => j.phase === "uploading");
  let idle = 0;
  while (uploading.length && idle < uploading.length) {
    const job = uploading[rr++ % uploading.length];
    const task = takeTask(job);
    if (!task) {
      idle++;
      continue;
    }
    const release = limiter.tryAcquire();
    if (!release) {
      job.redo.unshift(task);
      break;
    }
    idle = 0;
    void run(job, task, release);
  }
  // Something is waiting on a timer (backoff or Retry-After): wake up then.
  const soonest = Math.min(limiter.pausedUntil, ...uploading.flatMap((j) => j.redo.map((t) => t.notBefore)).filter((t) => t > Date.now()));
  if (Number.isFinite(soonest) && soonest > Date.now()) {
    if (wakeTimer) clearTimeout(wakeTimer);
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      pump();
    }, soonest - Date.now() + 20);
  }
}

interface SessionStatus {
  state: string;
  partSize: number;
  partCount: number;
  pieceSize: number;
  chunkSize: number;
  partsInFlight?: number;
  missing: MissingRange[];
}

/**
 * Picks up an existing session: the server says what it still lacks, and only
 * that is sent. "finished" if the file had landed meanwhile; "gone" if the
 * session no longer exists (cancelled, or kept past UPLOAD_RESUME_DAYS).
 */
async function reattach(job: Job): Promise<"attached" | "finished" | "gone"> {
  const id = job.session!.id;
  let st: SessionStatus;
  try {
    st = await apiRetry<SessionStatus>(`/api/uploads/${id}?coarse=1`, { signal: job.abort.signal });
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 410)) return "gone";
    throw e;
  }
  if (st.state === "completed" || st.state === "deduped") {
    // Completing again is idempotent and returns the file that landed.
    const res = await apiRetry<{ node: DriveNode; outcome?: UploadOutcome }>(`/api/uploads/${id}/complete`, { method: "POST", json: {}, signal: job.abort.signal });
    void finish(job, res.node, res.outcome ?? "created");
    return "finished";
  }
  if (st.state !== "active" && st.state !== "completing") return "gone";
  job.session = { id, partSize: st.partSize, pieceSize: st.pieceSize, chunkSize: st.chunkSize, partCount: st.partCount, partsInFlight: st.partsInFlight };
  job.sizes = partSizes(job.file.size, st.partSize);
  job.window = st.partsInFlight ?? job.sizes.length;
  resync(job, st.missing);
  update(job.id, { loaded: job.completed, resumed: job.completed > 0 });
  return "attached";
}

/** Hashes the file for the session's part size (reusing a fingerprint that already fits). */
function startHashing(job: Job) {
  const partSize = job.session!.partSize;
  if (job.file.size === 0 || (job.fp && job.fpPartSize === partSize)) return;
  job.fpCancel?.();
  const h = fingerprint(job.file, partSize, (f) => update(job.id, { hashed: f }));
  job.fp = h.promise;
  job.fpPartSize = partSize;
  job.fpCancel = h.cancel;
  job.fp.then(
    () => update(job.id, { hashed: 1 }),
    () => {},
  );
}

const maybeComplete = (job: Job) => {
  if (job.phase === "uploading" && !hasWork(job) && job.inflight.size === 0) void complete(job);
};

async function start(job: Job) {
  job.phase = "starting";
  const item = itemById(job.id)!;
  update(job.id, { status: "uploading", startedAt: Date.now(), note: undefined });
  job.lastSample = { t: performance.now(), bytes: 0 };
  try {
    if (job.session) {
      const r = await reattach(job);
      if (r === "finished" || isFinished(job)) return;
      if (r === "gone") {
        void forgetUpload(job.session.id);
        job.session = undefined;
        update(job.id, { loaded: 0, resumed: false });
      }
    }
    if (!job.session) {
      const init = await apiRetry<UploadInit | { node: DriveNode; outcome: UploadOutcome }>("/api/uploads", {
        method: "POST",
        json: { name: item.name, size: job.file.size, mime: job.file.type, parentId: item.parentId, onConflict: job.policy, takenAt: await readTakenAt(job.file) },
        idempotencyKey: job.idemKey,
        signal: job.abort.signal,
      });
      if ("node" in init) return finish(job, init.node, init.outcome);
      job.session = init;
      job.sizes = partSizes(job.file.size, init.partSize);
      job.cursors = job.sizes.map(() => 0);
      job.window = init.partsInFlight ?? job.sizes.length;
      void rememberUpload({
        session: init.id,
        name: job.file.name,
        size: job.file.size,
        lastModified: job.file.lastModified,
        type: job.file.type,
        parentId: item.parentId,
        destination: item.destination,
        policy: job.policy,
        partSize: init.partSize,
        savedAt: Date.now(),
      });
    }
    // Hash alongside the upload; it gates dedup and completion only.
    startHashing(job);
    if (job.hashFirst && job.fp) {
      // Likely the same file again: check before sending a single byte.
      update(job.id, { note: "Checking whether it's the same file…" });
      job.phase = "uploading";
      const planned = job.cursors;
      job.cursors = [...job.sizes]; // hold the planner until the answer is in
      const deduped = await job.fp.then(
        () => tryDedup(job),
        () => false,
      );
      if (deduped || isFinished(job)) return;
      job.cursors = planned;
      update(job.id, { note: undefined });
      pump();
      maybeComplete(job);
      return;
    }
    job.phase = "uploading";
    // Dedup as soon as both the session and the fingerprint exist (whichever lands last).
    job.fp?.then(
      () => tryDedup(job),
      () => {},
    );
    pump();
    maybeComplete(job); // a resumed upload may have nothing left to send
  } catch (e) {
    fail(job, e);
  }
}

async function run(job: Job, task: Task, release: (o: Outcome) => void) {
  const key = keyOf(task);
  const session = job.session!;
  job.inflight.set(key, { range: { part: task.part, offset: task.offset, length: task.length }, loaded: 0 });
  update(job.id, { status: "uploading", note: undefined });
  const t0 = performance.now();
  try {
    const start = task.part * session.partSize + task.offset;
    const buf = await job.file.slice(start, start + task.length).arrayBuffer();
    const digest = await contentDigest(buf);
    await putChunk(
      `/api/uploads/${session.id}?part=${task.part}&offset=${task.offset}`,
      buf,
      digest,
      (loaded) => {
        const entry = job.inflight.get(key);
        if (entry) entry.loaded = loaded;
        progress(job);
      },
      job.abort.signal,
    );
    const ms = performance.now() - t0;
    release({ type: "ok", ms, bytes: task.length });
    job.inflight.delete(key);
    job.completed += task.length;
    progress(job);
    // Adaptive chunk size: aim for 1.5–6 s per request.
    if (ms < 1500 && job.chunkSize < MAX_CHUNK) job.chunkSize *= 2;
    else if (ms > 6000 && job.chunkSize > MIN_CHUNK) job.chunkSize /= 2;
  } catch (e) {
    job.inflight.delete(key);
    progress(job);
    if (job.abort.signal.aborted || job.phase === "finished") {
      release({ type: "neutral" });
      return;
    }
    const err = e instanceof ApiError ? e : new ApiError(0, String(e));
    task.attempts++;
    if (err.status === 503 || err.status === 429) {
      release({ type: "overload", retryAfterSec: err.retryAfter ?? 2 });
      update(job.id, { status: "holding", note: "Server busy — waiting a moment" });
      job.redo.unshift({ ...task, notBefore: Date.now() + (err.retryAfter ?? 2) * 1000 });
    } else if (err.status === 0 || err.status === 502 || err.status === 504) {
      release({ type: "error" });
      if (task.attempts > MAX_TASK_ATTEMPTS) return fail(job, err);
      update(job.id, { status: "holding", note: navigator.onLine ? "Connection hiccup — retrying" : "Offline — waiting for network" });
      await waitOnline();
      job.redo.push({ ...task, notBefore: Date.now() + Math.random() * Math.min(20_000, 500 * 2 ** task.attempts) });
    } else if (err.status === 422) {
      // The bytes were damaged in transit; the server kept nothing. Resend.
      release({ type: "neutral" });
      if (task.attempts > 5) return fail(job, new Error("A chunk keeps arriving corrupted — check your connection"));
      job.redo.unshift({ ...task, notBefore: 0 });
    } else if (err.status === 409) {
      release({ type: "neutral" });
      await refresh(job);
    } else if (err.status === 410) {
      release({ type: "neutral" });
      return cancel(job.id, false);
    } else if (err.status === 404) {
      release({ type: "neutral" });
      return restart(job); // session expired server-side: start over cleanly
    } else {
      release({ type: "neutral" });
      return fail(job, err);
    }
  } finally {
    maybeComplete(job);
    pump();
  }
}

/** Asks the server what it still needs (after a 409: part reset or state change). */
async function refresh(job: Job) {
  try {
    const status = await apiRetry<SessionStatus>(`/api/uploads/${job.session!.id}?coarse=1`, { signal: job.abort.signal });
    if (status.state === "active") resync(job, status.missing);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return restart(job);
  }
}

async function tryDedup(job: Job): Promise<boolean> {
  if (job.phase !== "uploading" || !job.session) return false;
  const fp = await job.fp!;
  try {
    const res = await apiRetry<{ node: DriveNode | null; state: string; outcome?: UploadOutcome }>(`/api/uploads/${job.session.id}/dedup`, {
      method: "POST",
      json: { sha256: fp.sha256 },
      attempts: 3,
    });
    // Re-read the phase: it may have changed while the request was in flight.
    if (res.node && !isFinished(job)) {
      job.abort.abort(); // stop sending bytes the server already has
      void finish(job, res.node, res.outcome ?? "created", true);
      return true;
    }
  } catch {
    /* dedup is an optimisation; the normal path continues */
  }
  return false;
}

async function complete(job: Job) {
  if (job.phase !== "uploading") return;
  job.phase = "finishing";
  update(job.id, { status: "verifying", note: "Verifying checksums" });
  try {
    let integrity: { sha256?: string; parts?: string[] } = {};
    try {
      const fp = await job.fp!;
      if (fp.partSize === job.session!.partSize) integrity = { sha256: fp.sha256, parts: partRoots(fp) };
    } catch (e) {
      // No hash worker (old browser / blocked WASM): still land the file, just without assembly proof.
      console.warn("Upload integrity hashing unavailable:", e);
    }
    if (job.phase !== "finishing") return; // deduped meanwhile
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await apiRetry<{ node: DriveNode; outcome?: UploadOutcome }>(`/api/uploads/${job.session!.id}/complete`, {
          method: "POST",
          json: integrity,
          signal: job.abort.signal,
        });
        return finish(job, res.node, res.outcome ?? "created");
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          const retry = e.body as CompleteRetry;
          if (!retry?.missing || attempt > 4) throw e;
          // Self-healing assembly: resend only what the server could not verify.
          if (retry.reason === "checksum") update(job.id, { note: "Checksum mismatch — resending damaged parts" });
          resync(job, retry.missing);
          job.phase = "uploading";
          update(job.id, { status: "uploading" });
          pump();
          return;
        }
        throw e;
      }
    }
  } catch (e) {
    if (job.abort.signal.aborted) return;
    if (e instanceof ApiError && e.status === 410) return cancel(job.id, false);
    fail(job, e);
  }
}

// ---------------------------------------------------------------------------
// Terminal states
// ---------------------------------------------------------------------------

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleRefresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    const { invalidateDrive } = await import("../actions");
    invalidateDrive();
  }, 500);
}

async function finish(job: Job, node: DriveNode, outcome: UploadOutcome, linked = false) {
  if (job.phase === "finished") return;
  job.phase = "finished";
  job.fpCancel?.();
  if (job.session) void forgetUpload(job.session.id);
  const status: UploadStatus = outcome === "identical" ? "exists" : outcome === "skipped" ? "skipped" : linked ? "deduped" : "done";
  update(job.id, { status, outcome, finalName: node.name, nodeId: node.id, loaded: job.file.size, speed: 0, note: undefined, finishedAt: Date.now() });
  // Show the file immediately; the live feed / refetch reconciles. A replaced
  // file leaves the listing (it went to the trash).
  const { queryClient } = await import("../query-client");
  queryClient.setQueryData<FolderListing>(["folder", node.parentId ?? "root"], (old) => {
    if (!old || old.items.some((n) => n.id === node.id)) return old;
    const items = outcome === "replaced" ? old.items.filter((n) => n.kind !== "file" || n.name.toLowerCase() !== node.name.toLowerCase()) : old.items;
    return { ...old, items: [...items, node] };
  });
  scheduleRefresh();
  pump();
  const item = itemById(job.id);
  if ((status === "done" || status === "deduped") && !node.hasThumb && (item?.category === "image" || item?.category === "video")) {
    const thumb = await makeThumbnail(job.file, item.category);
    if (thumb) await uploadThumb(node.id, thumb).catch(() => {});
  }
}

/** Stops the job. The session stays remembered, so Retry continues from where it stopped. */
function fail(job: Job, e: unknown) {
  if (job.phase === "finished") return;
  job.phase = "finished";
  job.fpCancel?.();
  job.fp = undefined;
  const message = e instanceof Error ? e.message : String(e);
  update(job.id, { status: "error", error: message, speed: 0, note: undefined });
  pump();
}

function restart(job: Job) {
  job.phase = "finished"; // the old job's in-flight requests must not complete or fail the item
  job.abort.abort();
  if (job.session) void forgetUpload(job.session.id);
  const fresh = newJob(job.id, job.file, job.policy, job.hashFirst);
  // The fingerprint is still valid (re-hashing a huge file would take a while).
  fresh.fp = job.fp;
  fresh.fpPartSize = job.fpPartSize;
  fresh.fpCancel = job.fpCancel;
  jobs.set(job.id, fresh);
  update(job.id, { status: "queued", loaded: 0, resumed: false, note: "Session expired — starting again" });
  waiting.unshift(job.id);
  pump();
}

function newJob(id: number, file: File, policy: ConflictPolicy = "keep", hashFirst = false, session?: UploadInit): Job {
  return {
    id,
    file,
    policy,
    hashFirst,
    abort: new AbortController(),
    idemKey: randomKey("up"),
    session,
    sizes: [],
    cursors: [],
    window: 1,
    lowPart: 0,
    rr: 0,
    redo: [],
    inflight: new Map(),
    completed: 0,
    chunkSize: DEFAULT_CHUNK_SIZE,
    phase: "pending",
    lastSample: { t: 0, bytes: 0 },
  };
}

/** A session to continue: start() asks the server for the rest. */
const continuing = (s: SavedUpload): UploadInit => ({
  id: s.session,
  partSize: s.partSize,
  pieceSize: PIECE_SIZE,
  chunkSize: DEFAULT_CHUNK_SIZE,
  partCount: Math.ceil(s.size / s.partSize),
});

// ---------------------------------------------------------------------------
// Speed meter: EMA sampled twice a second
// ---------------------------------------------------------------------------
let ticker: ReturnType<typeof setInterval> | null = null;
function ensureTicker() {
  if (ticker) return;
  ticker = setInterval(() => {
    const now = performance.now();
    for (const job of jobs.values()) {
      const it = itemById(job.id);
      if (!it || (it.status !== "uploading" && it.status !== "holding")) continue;
      const dt = (now - job.lastSample.t) / 1000;
      if (dt <= 0) continue;
      const inst = Math.max(0, (it.loaded - job.lastSample.bytes) / dt);
      job.lastSample = { t: now, bytes: it.loaded };
      update(job.id, { speed: it.speed ? it.speed * 0.7 + inst * 0.3 : inst });
    }
    if (!activeCount() && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  }, 500);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface UploadEntry {
  file: File;
  /** Relative path including file name, e.g. "Photos/2024/a.jpg". */
  path?: string;
}

/**
 * Uploads files into a folder. Before a byte is sent, the server says which
 * names are taken; if any are, you choose what happens to them (keep both,
 * replace, skip). Folders that already exist are merged into. A file whose
 * upload was interrupted earlier continues where it stopped.
 */
export async function enqueueUploads(
  entries: UploadEntry[],
  parentId: string,
  emptyDirs: string[] = [],
  destination = "My files",
  /** `policy` decides clashes up front (e.g. "replace" for "upload a new version") instead of asking. */
  opts: { policy?: ConflictPolicy } = {},
) {
  if (!entries.length && !emptyDirs.length) return;
  const pathOf = (e: UploadEntry) => e.path ?? e.file.name;

  // 0. Interrupted uploads of these very files (same folder, name, size and date) continue.
  const resumes = new Map<UploadEntry, SavedUpload>();
  const saved = (await savedUploads()).filter((s) => s.parentId === parentId && !sessionBusy(s.session));
  for (const e of entries) {
    if (pathOf(e).includes("/")) continue;
    const s = saved.find((x) => sameFile(x, e.file) && ![...resumes.values()].includes(x));
    if (s) resumes.set(e, s);
  }
  if (resumes.size) {
    for (const [e, s] of resumes) continueUpload(s, e.file);
    entries = entries.filter((e) => !resumes.has(e));
    if (!entries.length && !emptyDirs.length) return;
  }

  // 1. Name clashes.
  const taken = new Map<string, { size: number; updatedAt: number }>();
  if (entries.length && !opts.policy) {
    try {
      const { conflicts } = await apiRetry<{ conflicts: { path: string; size: number; updatedAt: number }[] }>("/api/nodes/conflicts", {
        method: "POST",
        json: { parentId, paths: entries.map(pathOf) },
        attempts: 3,
      });
      for (const c of conflicts) taken.set(c.path, c);
    } catch {
      /* the server still never overwrites: names stay unique either way */
    }
  }
  let policy: ConflictPolicy = "keep";
  if (taken.size) {
    const answer = await useUi.getState().askConflict({
      folderName: destination,
      items: entries
        .filter((e) => taken.has(pathOf(e)))
        .map((e) => ({ path: pathOf(e), size: e.file.size, existingSize: taken.get(pathOf(e))!.size, existingAt: taken.get(pathOf(e))!.updatedAt })),
    });
    if (!answer) return;
    policy = answer;
    if (policy === "skip") {
      const skipped = entries.filter((e) => taken.has(pathOf(e))).length;
      entries = entries.filter((e) => !taken.has(pathOf(e)));
      toast(`Skipped ${skipped} file${skipped === 1 ? "" : "s"} that already exist`);
      if (!entries.length && !emptyDirs.length) return;
    }
  }

  // 2. Folders (existing ones are reused).
  const dirs = new Set(emptyDirs);
  for (const e of entries) {
    const segs = (e.path ?? e.file.name).split("/");
    for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join("/"));
  }
  let folderIds: Record<string, string> = {};
  if (dirs.size) {
    try {
      folderIds = (
        await apiRetry<{ folders: Record<string, string> }>("/api/nodes/mkdirp", {
          method: "POST",
          json: { parentId, paths: [...dirs] },
          idempotencyKey: randomKey("mk"),
        })
      ).folders;
      scheduleRefresh();
    } catch (e) {
      toast.error(`Could not create folders: ${(e as Error).message}`);
      return;
    }
  }

  const items: UploadItem[] = entries.map((e) => {
    const segs = (e.path ?? e.file.name).split("/");
    const dir = segs.slice(0, -1).join("/");
    const id = seq++;
    const clash = taken.get(pathOf(e));
    jobs.set(id, newJob(id, e.file, opts.policy ?? (clash ? policy : "keep"), !!clash && clash.size === e.file.size && e.file.size > 0));
    waiting.push(id);
    return {
      id,
      flight: `#${String(id).padStart(3, "0")}`,
      name: e.file.name,
      size: e.file.size,
      parentId: dir ? folderIds[dir] : parentId,
      destination: dir ? (segs.at(-2) ?? destination) : destination,
      category: categoryOf({ kind: "file", name: e.file.name, mime: e.file.type }),
      status: "queued",
      loaded: 0,
      hashed: 0,
      speed: 0,
    };
  });
  useUploads.setState((s) => ({ items: [...s.items, ...items], panelOpen: true, collapsed: false }));
  ensureTicker();
  pump();
}

/** Continues a remembered session with its file (reusing its interrupted row, if shown). */
function continueUpload(s: SavedUpload, file: File) {
  const shown = [...interrupted].find(([, v]) => v.session === s.session)?.[0];
  const id = shown ?? seq++;
  interrupted.delete(id);
  jobs.set(id, newJob(id, file, s.policy, false, continuing(s)));
  waiting.push(id);
  if (shown) {
    update(id, { status: "queued", note: "Continuing where it stopped", error: undefined });
  } else {
    const item: UploadItem = {
      id,
      flight: `#${String(id).padStart(3, "0")}`,
      name: s.name,
      size: s.size,
      parentId: s.parentId,
      destination: s.destination,
      category: categoryOf({ kind: "file", name: s.name, mime: s.type }),
      status: "queued",
      note: "Continuing where it stopped",
      loaded: 0,
      hashed: 0,
      speed: 0,
    };
    useUploads.setState((st) => ({ items: [...st.items, item], panelOpen: true, collapsed: false }));
  }
  ensureTicker();
  pump();
}

/**
 * Shows uploads that a reload, crash or closed tab interrupted. Their finished
 * parts are safe in Telegram; picking the file again continues them.
 */
let restoring: Promise<void> | null = null;
export function restoreInterrupted(): Promise<void> {
  restoring ??= (async () => {
    const rows: UploadItem[] = [];
    for (const s of await savedUploads()) {
      if (sessionBusy(s.session) || [...interrupted.values()].some((v) => v.session === s.session)) continue;
      let st: SessionStatus;
      try {
        st = await api<SessionStatus>(`/api/uploads/${s.session}?coarse=1`);
      } catch (e) {
        if (e instanceof ApiError && (e.status === 404 || e.status === 410)) void forgetUpload(s.session);
        continue; // offline or signed out: ask again next time
      }
      if (st.state !== "active" && st.state !== "completing") {
        void forgetUpload(s.session);
        continue;
      }
      const id = seq++;
      interrupted.set(id, s);
      rows.push({
        id,
        flight: `#${String(id).padStart(3, "0")}`,
        name: s.name,
        size: s.size,
        parentId: s.parentId,
        destination: s.destination,
        category: categoryOf({ kind: "file", name: s.name, mime: s.type }),
        status: "interrupted",
        loaded: s.size - st.missing.reduce((n, m) => n + m.length, 0),
        hashed: 0,
        speed: 0,
      });
    }
    if (rows.length) useUploads.setState((st) => ({ items: [...st.items, ...rows], panelOpen: true, collapsed: false }));
  })();
  return restoring;
}

/** Continues an interrupted upload with the file you picked. False if it isn't the same file. */
export function resumeUpload(id: number, file: File): boolean {
  const s = interrupted.get(id);
  if (!s || file.name !== s.name || file.size !== s.size) return false;
  continueUpload(s, file);
  return true;
}

/** Gives up on an interrupted upload: its finished parts are deleted from Telegram. */
export function discardUpload(id: number) {
  const s = interrupted.get(id);
  if (!s) return;
  interrupted.delete(id);
  void del(`/api/uploads/${s.session}`).catch(() => {});
  void forgetUpload(s.session);
  useUploads.setState((st) => {
    const items = st.items.filter((i) => i.id !== id);
    return { items, panelOpen: st.panelOpen && items.length > 0 };
  });
}

export function cancel(id: number, notifyServer = true) {
  const job = jobs.get(id);
  if (!job || job.phase === "finished") return;
  job.phase = "finished";
  job.abort.abort();
  job.fpCancel?.();
  const i = waiting.indexOf(id);
  if (i >= 0) waiting.splice(i, 1);
  if (job.session) {
    if (notifyServer) void del(`/api/uploads/${job.session.id}`).catch(() => {});
    void forgetUpload(job.session.id);
  }
  update(id, { status: "canceled", speed: 0, note: undefined });
  pump();
}

export const cancelUpload = (id: number) => cancel(id);

export function cancelAll() {
  for (const job of jobs.values()) if (job.phase !== "finished") cancel(job.id);
}

/** Tries again. After a failure the same session continues; after a cancel, a new one starts. */
export function retryUpload(id: number) {
  const job = jobs.get(id);
  const it = itemById(id);
  if (!job || !it || (it.status !== "error" && it.status !== "canceled")) return;
  const session = it.status === "error" ? job.session : undefined;
  jobs.set(id, newJob(id, job.file, job.policy, job.hashFirst, session));
  update(id, { status: "queued", error: undefined, loaded: 0, hashed: 0, note: undefined });
  waiting.push(id);
  ensureTicker();
  pump();
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", (e) => {
    if (activeCount() > 0) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  // Resume immediately when connectivity returns instead of waiting out backoff timers.
  window.addEventListener("online", () => {
    for (const job of jobs.values()) for (const t of job.redo) t.notBefore = 0;
    pump();
  });
}
