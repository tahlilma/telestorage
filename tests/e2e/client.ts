import crypto from "node:crypto";
import { inject } from "vitest";
import type { DriveNode } from "@/lib/types";
import { fileDigests, planChunks, shuffle, sliceFor } from "../support/upload-client";

/** Provided by tests/e2e/global-setup.ts (a throwaway server, or E2E_BASE_URL). */
export const BASE = inject("e2eBaseUrl").replace(/\/+$/, "");
export const DATA_DIR = inject("e2eData") || null;
export const TIGHT_URL = inject("e2eTightUrl") || null;
export const PASSWORD = process.env.E2E_PASSWORD ?? "e2e-pass-123";

/** A minimal browser stand-in: one cookie jar, JSON helpers, the upload protocol, the live feed. */
export class Client {
  cookie = "";

  constructor(readonly base = BASE) {}

  /**
   * Like a browser: a request that dies on a reused keep-alive socket before any
   * response arrives is sent again. Safe here because every non-idempotent POST
   * carries an Idempotency-Key — the same guarantee the real client relies on.
   */
  async fetch(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (this.cookie) headers.set("cookie", this.cookie);
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(this.base + path, { ...init, headers, redirect: "manual" });
        for (const c of res.headers.getSetCookie()) this.cookie = c.split(";")[0];
        return res;
      } catch (e) {
        const code = (e as { cause?: { code?: string } }).cause?.code;
        if (attempt >= 3 || init.signal?.aborted || !(code === "ECONNRESET" || code === "UND_ERR_SOCKET" || code === "EPIPE")) throw e;
      }
    }
  }

  async json<T = Record<string, unknown>>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T; headers: Headers }> {
    const res = await this.fetch(path, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T, headers: res.headers };
  }

  async login(password = PASSWORD) {
    const r = await this.json("POST", "/api/auth/login", { password });
    if (r.status !== 200) throw new Error(`login failed: ${r.status} ${JSON.stringify(r.body)}`);
    return this;
  }

  async listing(parent = "root") {
    return (await this.json<{ items: DriveNode[] }>("GET", `/api/nodes?parent=${parent}`)).body.items;
  }

  async mkdir(name: string, parentId = "root") {
    const r = await this.json<{ node: DriveNode }>("POST", "/api/nodes", { parentId, name }, { "idempotency-key": key("mk") });
    return r.body.node;
  }

  async putChunk(uploadId: string, part: number, offset: number, data: Buffer, digest = contentDigest(data)) {
    const res = await this.fetch(`/api/uploads/${uploadId}?part=${part}&offset=${offset}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream", "content-digest": digest },
      body: new Uint8Array(data),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, retryAfter: res.headers.get("retry-after") };
  }

  async init(name: string, size: number, parentId = "root", idem = key("up")) {
    return this.json<{ id: string; partSize: number } & { node?: DriveNode }>("POST", "/api/uploads", { name, size, mime: "application/octet-stream", parentId }, { "idempotency-key": idem });
  }

  /** Full client protocol: init → chunks (shuffled, concurrent) → complete with SHA-256 + window hashes. */
  async upload(name: string, data: Buffer, opts: { parentId?: string; concurrency?: number; chunkSize?: number } = {}): Promise<DriveNode> {
    const init = await this.init(name, data.length, opts.parentId);
    if (init.status !== 201) throw new Error(`init ${init.status} ${JSON.stringify(init.body)}`);
    if (init.body.node) return init.body.node;
    const { id, partSize } = init.body;
    const queue = shuffle(planChunks(data.length, partSize, opts.chunkSize ?? 2 * 1024 * 1024));
    const worker = async () => {
      for (let r = queue.shift(); r; r = queue.shift()) {
        for (let attempt = 0; ; attempt++) {
          const res = await this.putChunk(id, r.part, r.offset, sliceFor(data, partSize, r));
          if (res.status === 200) break;
          if (res.status === 503 && attempt < 20) {
            await new Promise((ok) => setTimeout(ok, Number(res.retryAfter ?? 1) * 1000));
            continue;
          }
          throw new Error(`chunk ${r.part}:${r.offset} → ${res.status} ${JSON.stringify(res.body)}`);
        }
      }
    };
    await Promise.all(Array.from({ length: opts.concurrency ?? 4 }, worker));
    const done = await this.json<{ node: DriveNode }>("POST", `/api/uploads/${id}/complete`, fileDigests(data, partSize));
    if (done.status !== 200) throw new Error(`complete ${done.status} ${JSON.stringify(done.body)}`);
    return done.body.node;
  }

  async download(node: DriveNode, range?: string) {
    const res = await this.fetch(`/api/files/${node.id}/${encodeURIComponent(node.name)}`, { headers: range ? { range } : {} });
    return { status: res.status, data: Buffer.from(await res.arrayBuffer()), headers: res.headers };
  }

  /** Subscribes to /api/events and records every event. */
  async live() {
    const ctrl = new AbortController();
    const res = await this.fetch("/api/events", { signal: ctrl.signal, headers: { accept: "text/event-stream" } });
    if (res.status !== 200 || !res.body) throw new Error(`events → ${res.status}`);
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const waiters = new Set<() => void>();
    void (async () => {
      const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buf += value;
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const event = /^event: (.*)$/m.exec(block)?.[1];
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (event && data) {
              events.push({ event, data: JSON.parse(data) });
              for (const w of waiters) w();
            }
          }
        }
      } catch {
        /* aborted */
      }
    })();
    const waitFor = (pred: (e: { event: string; data: Record<string, unknown> }) => boolean, ms = 15_000) =>
      new Promise<{ event: string; data: Record<string, unknown> }>((resolve, reject) => {
        const check = () => {
          const hit = events.find(pred);
          if (hit) {
            waiters.delete(check);
            clearTimeout(t);
            resolve(hit);
          }
        };
        const t = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`timed out waiting for live event; got ${JSON.stringify(events.map((e) => [e.event, e.data.type, e.data.reason]))}`));
        }, ms);
        waiters.add(check);
        check();
      });
    return { events, waitFor, close: () => ctrl.abort() };
  }
}

export const key = (prefix: string) => `${prefix}-${crypto.randomBytes(12).toString("hex")}`;
export const contentDigest = (b: Buffer) => `sha-256=:${crypto.createHash("sha256").update(b).digest("base64")}:`;
export const randomBytes = (n: number) => crypto.randomBytes(n);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
