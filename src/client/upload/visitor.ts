"use client";
import { create } from "zustand";
import { partSizes, type CompleteRetry, type MissingRange } from "@/lib/protocol";
import { ApiError, api, apiRetry, sleep, waitOnline } from "../api";
import { contentDigest, fingerprint, partRoots, type Fingerprint } from "./hasher";
import { readTakenAt } from "./media-meta";
import { putChunk } from "./transport";

/**
 * Uploads for people sending files through a file request. Same protocol and
 * guarantees as the owner's engine — SHA-256 per chunk, a hash tree per part,
 * resend only what's missing — but talking only to the request's scoped
 * endpoints, which accept uploads into one folder and reveal nothing else.
 */

export type VisitorStatus = "queued" | "uploading" | "verifying" | "done" | "error" | "canceled";

export interface VisitorItem {
  id: number;
  name: string;
  size: number;
  type: string;
  loaded: number;
  status: VisitorStatus;
  error?: string;
}

export const useVisitorUploads = create<{ items: VisitorItem[] }>()(() => ({ items: [] }));

const patch = (id: number, p: Partial<VisitorItem>) => useVisitorUploads.setState((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, ...p } : i)) }));

const CHUNK = 8 * 1024 * 1024;
const PARALLEL_CHUNKS = 4;
const PARALLEL_FILES = 2;
const aborts = new Map<number, AbortController>();
const queue: { id: number; file: File }[] = [];
let running = 0;
let seq = 1;
let ctx = { token: "", from: null as string | null };

/** Queues files for the request `token`, sent as `from` (the name the visitor typed, if any). */
export function sendFiles(token: string, files: File[], from: string | null) {
  ctx = { token, from };
  const added = files.map((file) => {
    const id = seq++;
    queue.push({ id, file });
    return { id, name: file.name, size: file.size, type: file.type, loaded: 0, status: "queued" as const };
  });
  useVisitorUploads.setState((s) => ({ items: [...s.items, ...added] }));
  pump();
}

export function cancelVisitorUpload(id: number) {
  const i = queue.findIndex((q) => q.id === id);
  if (i >= 0) queue.splice(i, 1);
  aborts.get(id)?.abort();
  patch(id, { status: "canceled" });
}

function pump() {
  while (running < PARALLEL_FILES && queue.length) {
    const next = queue.shift()!;
    running++;
    void send(next.id, next.file).finally(() => {
      running--;
      pump();
    });
  }
}

interface Init {
  id: string;
  partSize: number;
  done?: boolean;
}

async function send(id: number, file: File) {
  const ctrl = new AbortController();
  aborts.set(id, ctrl);
  const base = `/api/public/${ctx.token}/uploads`;
  let session: string | null = null;
  let fp: { promise: Promise<Fingerprint>; cancel: () => void } | null = null;
  try {
    patch(id, { status: "uploading" });
    const init = await apiRetry<Init>(base, {
      method: "POST",
      json: { name: file.name, size: file.size, mime: file.type, from: ctx.from, takenAt: await readTakenAt(file) },
      signal: ctrl.signal,
      attempts: 4,
    });
    if (init.done) return patch(id, { status: "done", loaded: file.size });
    session = init.id;
    fp = fingerprint(file, init.partSize);
    fp.promise.catch(() => {});
    const sizes = partSizes(file.size, init.partSize);
    let todo: MissingRange[] = sizes.flatMap((bytes, part) =>
      Array.from({ length: Math.ceil(bytes / CHUNK) }, (_, k) => ({ part, offset: k * CHUNK, length: Math.min(CHUNK, bytes - k * CHUNK) })),
    );
    let sentBytes = 0;
    const inflight = new Map<string, number>();
    const report = () => patch(id, { loaded: Math.min(file.size, sentBytes + [...inflight.values()].reduce((a, b) => a + b, 0)) });

    for (let round = 0; round < 6; round++) {
      // Send everything still missing, a few chunks at a time, in order.
      let cursor = 0;
      const worker = async () => {
        while (cursor < todo.length) {
          const t = todo[cursor++];
          const key = `${t.part}:${t.offset}`;
          for (let attempt = 1; ; attempt++) {
            const start = t.part * init.partSize + t.offset;
            const buf = await file.slice(start, start + t.length).arrayBuffer();
            try {
              await putChunk(
                `${base}/${session}?part=${t.part}&offset=${t.offset}`,
                buf,
                await contentDigest(buf),
                (n) => {
                  inflight.set(key, n);
                  report();
                },
                ctrl.signal,
              );
              inflight.delete(key);
              sentBytes += t.length;
              report();
              break;
            } catch (e) {
              inflight.delete(key);
              if (ctrl.signal.aborted) throw e;
              const status = e instanceof ApiError ? e.status : 0;
              if (status === 410 || status === 404 || status === 413 || status === 400 || attempt >= 12) throw e;
              await waitOnline();
              await sleep(status === 422 ? 0 : Math.min(15_000, 400 * 2 ** attempt * Math.random() + 200), ctrl.signal);
            }
          }
        }
      };
      await Promise.all(Array.from({ length: PARALLEL_CHUNKS }, worker));

      patch(id, { status: "verifying", loaded: file.size });
      const proof = await fp.promise.then(
        (f) => ({ sha256: f.sha256, parts: partRoots(f) }),
        () => ({}),
      );
      try {
        await apiRetry(`${base}/${session}/complete`, { method: "POST", json: proof, signal: ctrl.signal, attempts: 4 });
        return patch(id, { status: "done", loaded: file.size });
      } catch (e) {
        const retry = e instanceof ApiError && e.status === 409 ? (e.body as CompleteRetry) : null;
        if (!retry?.missing?.length) throw e;
        // Resend only what the server could not verify, in request-sized slices.
        todo = retry.missing.flatMap((m) =>
          Array.from({ length: Math.ceil(m.length / CHUNK) }, (_, k) => ({ part: m.part, offset: m.offset + k * CHUNK, length: Math.min(CHUNK, m.length - k * CHUNK) })),
        );
        sentBytes = file.size - retry.missing.reduce((n, m) => n + m.length, 0);
        patch(id, { status: "uploading" });
      }
    }
    throw new Error("The upload kept failing its checksum — please try again");
  } catch (e) {
    fp?.cancel();
    if (ctrl.signal.aborted) {
      if (session) void api(`${base}/${session}`, { method: "DELETE" }).catch(() => {});
      return;
    }
    patch(id, { status: "error", error: e instanceof Error ? e.message : String(e) });
  } finally {
    aborts.delete(id);
  }
}

