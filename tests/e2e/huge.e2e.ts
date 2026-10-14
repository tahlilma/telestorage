import crypto from "node:crypto";
import { describe, expect, inject, it } from "vitest";
import { PIECE_SIZE, partSizes, windowsOfPart, type MissingRange } from "@/lib/protocol";
import type { DriveNode } from "@/lib/types";
import { Client, key, sleep } from "./client";

/**
 * A file far past Telegram's 2 GB-per-file limit and past the 4 GiB mark
 * where 32-bit offsets overflow, through the real HTTP stack:
 *   - content comes from a deterministic generator, so nothing big is ever
 *     held in memory (the same constraint the browser has),
 *   - sent the way the browser sends it: a sliding window of 512 MiB parts,
 *     16 MiB chunks with SHA-256 digests,
 *   - interrupted halfway and resumed from what the server says it lacks,
 *   - proven with one hash-tree root per part,
 *   - then read back with range requests across 4 GiB and in full.
 *
 *   HUGE_FILE_GB=5 npm run test:e2e -- huge
 */
const GB = Number(process.env.HUGE_FILE_GB ?? 0);
const HUGE = inject("e2eHugeUrl");
const SIZE = Math.round(GB * 1024 ** 3) + 12_345; // ragged on purpose: the last part and piece are partial
const CHUNK = 16 * 1024 * 1024;
const CONCURRENCY = 6;

// Content at any offset: an AES-256-CTR keystream (fast, and identical however it's sliced).
const KEY = crypto.createHash("sha256").update("telestorage huge file").digest();
function ivAt(offset: number): Buffer {
  const iv = Buffer.alloc(16);
  let n = BigInt(offset / 16);
  for (let i = 15; i >= 0 && n > 0n; i--) {
    iv[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return iv;
}
function bytesAt(offset: number, length: number): Buffer {
  const start = offset - (offset % 16);
  const cipher = crypto.createCipheriv("aes-256-ctr", KEY, ivAt(start));
  return cipher.update(Buffer.alloc(length + offset - start)).subarray(offset - start);
}

const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest();

/** What the browser's hash worker computes: whole-file SHA-256 + a hash-tree root per part. */
function fingerprint(size: number, partSize: number) {
  const whole = crypto.createHash("sha256");
  const parts: string[] = [];
  let pos = 0;
  for (const bytes of partSizes(size, partSize)) {
    const end = pos + bytes;
    const root = crypto.createHash("sha256");
    for (const pieces of windowsOfPart(bytes)) {
      const buf = bytesAt(pos, Math.min(pieces * PIECE_SIZE, end - pos));
      whole.update(buf);
      const win = crypto.createHash("sha256");
      for (let q = 0; q < buf.length; q += PIECE_SIZE) win.update(sha(buf.subarray(q, q + PIECE_SIZE)));
      root.update(win.digest());
      pos += buf.length;
    }
    parts.push(root.digest("hex"));
  }
  return { sha256: whole.digest("hex"), parts };
}

/** Request-sized slices, ordered like the browser's planner: `window` parts at a time, round-robin. */
function plan(ranges: MissingRange[], window: number): MissingRange[] {
  const byPart = new Map<number, MissingRange[]>();
  for (const r of ranges) {
    const list = byPart.get(r.part) ?? [];
    for (let o = 0; o < r.length; o += CHUNK) list.push({ part: r.part, offset: r.offset + o, length: Math.min(CHUNK, r.length - o) });
    byPart.set(r.part, list);
  }
  const parts = [...byPart.keys()].sort((a, b) => a - b);
  const out: MissingRange[] = [];
  for (let g = 0; g < parts.length; g += window) {
    const group = parts.slice(g, g + window).map((p) => byPart.get(p)!);
    for (let k = 0; group.some((q) => k < q.length); k++) for (const q of group) if (k < q.length) out.push(q[k]);
  }
  return out;
}

async function send(c: Client, id: string, partSize: number, tasks: MissingRange[], stopAfter = Infinity) {
  let next = 0;
  let sent = 0;
  const worker = async () => {
    while (next < tasks.length && sent < stopAfter) {
      const r = tasks[next++];
      const data = bytesAt(r.part * partSize + r.offset, r.length);
      for (let attempt = 0; ; attempt++) {
        const res = await c.putChunk(id, r.part, r.offset, data);
        if (res.status === 200) break;
        if (res.status === 503 && attempt < 30) {
          await sleep(Number(res.retryAfter ?? 1) * 1000);
          continue;
        }
        throw new Error(`chunk ${r.part}:${r.offset} → ${res.status} ${JSON.stringify(res.body)}`);
      }
      sent += r.length;
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return sent;
}

const mb = (bytes: number, ms: number) => `${(bytes / 1024 ** 2 / (ms / 1000)).toFixed(0)} MiB/s`;

describe.skipIf(!(GB > 0 && HUGE))(`a ${GB} GiB file`, () => {
  const c = new Client(HUGE);
  let node: DriveNode;
  let proof: { sha256: string; parts: string[] };

  it("uploads in 512 MiB parts, survives an interruption and resumes without resending", async () => {
    await c.login();
    const init = await c.json<{ id: string; partSize: number; partCount: number; partsInFlight: number }>(
      "POST",
      "/api/uploads",
      { name: "huge.bin", size: SIZE, mime: "application/octet-stream", parentId: "root" },
      { "idempotency-key": key("up") },
    );
    expect(init.status).toBe(201);
    const { id, partSize, partCount, partsInFlight } = init.body;
    expect(partSize).toBe(512 * 1024 * 1024);
    expect(partCount).toBe(Math.ceil(SIZE / partSize));

    let t = performance.now();
    proof = fingerprint(SIZE, partSize);
    console.log(`hashed ${GB} GiB (SHA-256 + part roots) at ${mb(SIZE, performance.now() - t)}`);

    t = performance.now();
    const everything = partSizes(SIZE, partSize).map((length, part) => ({ part, offset: 0, length }));
    const first = await send(c, id, partSize, plan(everything, partsInFlight), SIZE / 2);

    // The tab closes. A new page asks the server what is still missing.
    const st = await c.json<{ state: string; missing: MissingRange[] }>("GET", `/api/uploads/${id}?coarse=1`);
    expect(st.body.state).toBe("active");
    const missing = st.body.missing.reduce((n, m) => n + m.length, 0);
    const untouched = partSizes(SIZE, partSize).filter((_, p) => !st.body.missing.some((m) => m.part === p)).length;
    expect(untouched).toBeGreaterThan(0); // finished parts are durable: never asked for again
    expect(missing).toBe(SIZE - first); // exactly what wasn't sent, nothing more

    const second = await send(c, id, partSize, plan(st.body.missing, partsInFlight));
    expect(first + second).toBe(SIZE); // not a byte sent twice
    const done = await c.json<{ node: DriveNode; outcome: string }>("POST", `/api/uploads/${id}/complete`, proof);
    expect(done.status).toBe(200);
    node = done.body.node;
    expect(node.size).toBe(SIZE);
    console.log(`uploaded ${GB} GiB in ${partCount} parts (resumed after ${(first / 1024 ** 3).toFixed(2)} GiB) at ${mb(SIZE, performance.now() - t)}`);
  }, 60 * 60_000);

  it("reads back exactly, across part boundaries and the 4 GiB mark", async () => {
    const starts = [2 ** 31 - 7, 2 ** 32 - 5, 3 * 512 * 1024 ** 2 - 9, SIZE - 1000].filter((s) => s > 0 && s < SIZE);
    for (const start of starts) {
      const end = Math.min(SIZE - 1, start + 3 * 1024 * 1024);
      const r = await c.download(node, `bytes=${start}-${end}`);
      expect(r.status).toBe(206);
      expect(r.headers.get("content-range")).toBe(`bytes ${start}-${end}/${SIZE}`);
      expect(r.data.equals(bytesAt(start, end - start + 1))).toBe(true);
    }
  }, 5 * 60_000);

  it("streams the whole file back with the same SHA-256", async () => {
    const t = performance.now();
    const res = await c.fetch(`/api/files/${node.id}/huge.bin`);
    expect(res.status).toBe(200);
    expect(Number(res.headers.get("content-length"))).toBe(SIZE);
    const h = crypto.createHash("sha256");
    let n = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      h.update(chunk);
      n += chunk.length;
    }
    expect(n).toBe(SIZE);
    expect(h.digest("hex")).toBe(proof.sha256);
    console.log(`downloaded and verified ${GB} GiB at ${mb(SIZE, performance.now() - t)}`);
  }, 60 * 60_000);

  it("uploading it again stores nothing new", async () => {
    const again = await c.json<{ id: string }>("POST", "/api/uploads", { name: "huge again.bin", size: SIZE, mime: null, parentId: "root" }, { "idempotency-key": key("up") });
    const d = await c.json<{ state: string; node: DriveNode }>("POST", `/api/uploads/${again.body.id}/dedup`, { sha256: proof.sha256 });
    expect(d.body.state).toBe("deduped");
    expect(d.body.node.blobId).toBe(node.blobId);
  });
});
