"use client";
export interface Fingerprint {
  sha256: string;
  /** Hash-tree root of every part, concatenated (32 bytes each); see protocol.ts. */
  parts: Uint8Array;
  partSize: number;
}

const toHex = (b: ArrayBuffer | Uint8Array) => Array.from(b instanceof Uint8Array ? b : new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
const toB64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...(b instanceof Uint8Array ? b : new Uint8Array(b))));

/** SHA-256 on the fastest available path: WebCrypto in secure contexts, WASM elsewhere. */
async function sha256(data: ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  if (globalThis.crypto?.subtle) {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", data instanceof Uint8Array ? (data.slice().buffer as ArrayBuffer) : data));
  }
  const { createSHA256 } = await import("hash-wasm");
  const h = await createSHA256();
  h.init();
  h.update(data instanceof Uint8Array ? data : new Uint8Array(data));
  return h.digest("binary");
}

/** RFC 9530 Content-Digest value for a chunk body. */
export async function contentDigest(buf: ArrayBuffer): Promise<string> {
  return `sha-256=:${toB64(await sha256(buf))}:`;
}

// ---------------------------------------------------------------------------
// Worker pool
// ---------------------------------------------------------------------------

interface Waiter {
  partSize: number;
  resolve: (f: Fingerprint) => void;
  reject: (e: Error) => void;
  onProgress?: (fraction: number) => void;
}

let workers: Worker[] = [];
let next = 0;
let seq = 1;
const waiters = new Map<number, Waiter>();

function pool(): Worker[] {
  if (workers.length) return workers;
  const n = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));
  workers = Array.from({ length: n }, () => {
    const w = new Worker(new URL("./hash-worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<{ id: number; progress?: number; sha256?: string; parts?: ArrayBuffer; error?: string }>) => {
      const waiter = waiters.get(e.data.id);
      if (!waiter) return;
      if (e.data.progress !== undefined) return waiter.onProgress?.(e.data.progress);
      waiters.delete(e.data.id);
      if (e.data.sha256 && e.data.parts) waiter.resolve({ sha256: e.data.sha256, parts: new Uint8Array(e.data.parts), partSize: waiter.partSize });
      else waiter.reject(new Error(e.data.error ?? "Hashing failed"));
    };
    return w;
  });
  return workers;
}

/** Fingerprints a file (for parts of `partSize`) in a worker; cancellable; reports progress 0..1. */
export function fingerprint(file: File, partSize: number, onProgress?: (fraction: number) => void): { promise: Promise<Fingerprint>; cancel: () => void } {
  const id = seq++;
  const worker = pool()[next++ % pool().length];
  const promise = new Promise<Fingerprint>((resolve, reject) => waiters.set(id, { partSize, resolve, reject, onProgress }));
  worker.postMessage({ id, file, partSize });
  return {
    promise,
    cancel: () => {
      worker.postMessage({ id, cancel: true });
      waiters.get(id)?.reject(new Error("canceled"));
      waiters.delete(id);
    },
  };
}

/** The part roots as hex, in part order: the proof sent when completing an upload. */
export function partRoots(fp: Fingerprint): string[] {
  const out: string[] = [];
  for (let o = 0; o < fp.parts.length; o += 32) out.push(toHex(fp.parts.subarray(o, o + 32)));
  return out;
}
