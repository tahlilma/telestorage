import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { body, fileDigests, legacyDigests, planChunks, sha, shuffle, sliceFor } from "../support/upload-client";

// 4 MiB parts so small test files span several Telegram-style parts.
process.env.TG_PART_SIZE_MB = "4";
process.env.ENCRYPTION_KEY = "test passphrase for the upload suite";
const PART = 4 * 1024 * 1024;

type Uploads = typeof import("@/server/storage/uploads");
type Blobs = typeof import("@/server/storage/blobs");
type Runtime = import("@/server/storage").Runtime;
let up: Uploads;
let blobs: Blobs;
let rt: Runtime;
let sql: typeof import("@/server/db").sql;
let kickGc: typeof import("@/server/storage/maintenance").kickGc;
let metrics: typeof import("@/server/metrics").metrics;
let shutdown: () => Promise<void>;

beforeAll(async () => {
  const s = await import("@/server/storage");
  rt = await s.storage();
  shutdown = s.shutdownStorage;
  up = await import("@/server/storage/uploads");
  blobs = await import("@/server/storage/blobs");
  ({ sql } = await import("@/server/db"));
  ({ kickGc } = await import("@/server/storage/maintenance"));
  ({ metrics } = await import("@/server/metrics"));
});

afterAll(async () => {
  await shutdown();
});

const rand = (n: number) => crypto.randomBytes(n);

async function send(id: string, data: Buffer, r: { part: number; offset: number; length: number }, digest?: Buffer) {
  const chunk = sliceFor(data, PART, r);
  return up.writeChunk(rt, id, r.part, r.offset, body(chunk), { digest: digest ?? sha(chunk), contentLength: chunk.length });
}

async function sendAll(id: string, data: Buffer, ranges: { part: number; offset: number; length: number }[], concurrency = 4) {
  let i = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (i < ranges.length) await send(id, data, ranges[i++]);
    }),
  );
}

async function complete(id: string, data: Buffer) {
  const d = fileDigests(data, PART);
  for (let round = 0; round < 5; round++) {
    const res = await up.completeUpload(rt, id, d);
    if ("node" in res) return res.node;
    await sendAll(id, data, res.missing);
  }
  throw new Error("upload never completed");
}

async function uploadAll(data: Buffer, name = "file.bin") {
  const init = up.createUpload(rt, { name, size: data.length, mime: "application/octet-stream", parentId: "root" });
  if ("node" in init) return init.node;
  const ranges = planChunks(data.length, init.partSize);
  await sendAll(init.id, data, [...shuffle(ranges), ranges[0]]); // out of order + a duplicate
  return complete(init.id, data);
}

async function readAll(blobId: string, start = 0, end?: number) {
  const blob = blobs.loadBlob(blobId)!;
  const reader = blobs.openRangeStream(rt, blob, start, end ?? blob.size - 1).getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return Buffer.concat(parts);
}

describe("upload pipeline", () => {
  it("uploads a multi-part file out of order with duplicates and reads it back byte-exact", async () => {
    const data = rand(PART * 2 + 3 * 1024 * 1024 + 12_345);
    const node = await uploadAll(data);
    expect(node.size).toBe(data.length);
    const blob = blobs.loadBlob(node.blobId!)!;
    expect(blob.partCount).toBe(3);
    expect(blob.sha256).toBe(sha(data).toString("hex"));
    expect(blob.parts.every((p) => p.pieceHashes && p.pieceHashes.length === Math.ceil(p.size / (512 * 1024)) * 32)).toBe(true);
    expect((await readAll(node.blobId!)).equals(data)).toBe(true);
    // ranges across block and part boundaries
    for (const [a, b] of [
      [PART - 7, PART + 7],
      [1048575, 1048577],
      [data.length - 3, data.length - 1],
    ]) {
      expect((await readAll(node.blobId!, a, b)).equals(data.subarray(a, b + 1))).toBe(true);
    }
  });

  it("stores ciphertext at rest when encryption is on", async () => {
    const data = Buffer.alloc(700_000, 0x41);
    const node = await uploadAll(data);
    const blob = blobs.loadBlob(node.blobId!)!;
    expect(blob.encIv).toBeTruthy();
    const stored = await rt.driver.readBlock(blob.parts[0].ref, 0, data.length);
    expect(stored.includes(Buffer.alloc(64, 0x41))).toBe(false);
    expect((await readAll(node.blobId!)).equals(data)).toBe(true);
  });

  it("rejects a chunk whose SHA-256 does not match and accepts the resend", async () => {
    const data = rand(3 * 1024 * 1024);
    const init = up.createUpload(rt, { name: "digest.bin", size: data.length, mime: null, parentId: "root" }) as { id: string };
    const r = { part: 0, offset: 0, length: data.length };
    await expect(send(init.id, data, r, sha(Buffer.from("nope")))).rejects.toMatchObject({ status: 422 });
    expect(up.uploadStatus(init.id).missing.length).toBe(1); // nothing was recorded
    await send(init.id, data, r);
    const node = await complete(init.id, data);
    expect((await readAll(node.blobId!)).equals(data)).toBe(true);
  });

  it("catches misplaced data at assembly time and resends only the affected part", async () => {
    const data = rand(3 * PART); // three 4 MiB parts
    const init = up.createUpload(rt, { name: "misplaced.bin", size: data.length, mime: null, parentId: "root" }) as { id: string };
    const ranges = planChunks(data.length, PART);
    expect(ranges.length).toBe(3);
    // Part 2 receives part 1's bytes: the digest matches what was sent, but the position is wrong.
    const fake = sliceFor(data, PART, ranges[1]);
    await send(init.id, data, ranges[0]);
    await send(init.id, data, ranges[1]);
    await up.writeChunk(rt, init.id, 2, 0, body(fake), { digest: sha(fake), contentLength: fake.length });
    const mismatches = metrics.counters["upload.windowMismatches"];
    const redone = metrics.counters["upload.partsRedone"];
    const res = await up.completeUpload(rt, init.id, fileDigests(data, PART));
    expect("missing" in res && res.reason).toBe("checksum");
    expect("missing" in res && res.missing).toEqual([ranges[2]]); // parts 0 and 1 stay as they are
    expect(metrics.counters["upload.windowMismatches"]).toBe(mismatches + 1);
    expect(metrics.counters["upload.partsRedone"]).toBe(redone + 1);
    const node = await complete(init.id, data);
    expect((await readAll(node.blobId!)).equals(data)).toBe(true);
  });

  it("redoes a committed part when its bytes fail assembly verification", async () => {
    const data = rand(PART + 1024 * 1024);
    const init = up.createUpload(rt, { name: "redo.bin", size: data.length, mime: null, parentId: "root" }) as { id: string };
    const ranges = planChunks(data.length, PART);
    const evil = rand(ranges[0].length);
    await up.writeChunk(rt, init.id, 0, 0, body(evil), { digest: sha(evil), contentLength: evil.length }); // part 0 commits with wrong bytes
    await send(init.id, data, ranges[1]);
    await new Promise((r) => setTimeout(r, 50)); // let the background commit land
    const before = metrics.counters["upload.partsRedone"];
    const res = await up.completeUpload(rt, init.id, fileDigests(data, PART));
    expect("missing" in res && res.reason).toBe("checksum");
    expect(metrics.counters["upload.partsRedone"]).toBe(before + 1);
    const node = await complete(init.id, data);
    expect((await readAll(node.blobId!)).equals(data)).toBe(true);
  });

  it("serialises concurrent completes and replays the result afterwards", async () => {
    const data = rand(2 * 1024 * 1024);
    const init = up.createUpload(rt, { name: "twice.bin", size: data.length, mime: null, parentId: "root" }) as { id: string };
    await sendAll(init.id, data, planChunks(data.length, PART));
    const d = fileDigests(data, PART);
    const [a, b] = await Promise.all([up.completeUpload(rt, init.id, d), up.completeUpload(rt, init.id, d)]);
    expect("node" in a && "node" in b && a.node.id === b.node.id).toBe(true);
    const again = await up.completeUpload(rt, init.id, d);
    expect("node" in again && "node" in a && again.node.id === a.node.id).toBe(true);
    const files = sql("SELECT COUNT(*) FROM nodes WHERE name = 'twice.bin'").pluck().get();
    expect(files).toBe(1);
  });

  it("lets a finished upload win over a racing abort", async () => {
    const data = rand(1024 * 1024);
    const init = up.createUpload(rt, { name: "race.bin", size: data.length, mime: null, parentId: "root" }) as { id: string };
    await sendAll(init.id, data, planChunks(data.length, PART));
    const [done, aborted] = await Promise.all([up.completeUpload(rt, init.id, fileDigests(data, PART)), up.abortUpload(rt, init.id)]);
    expect("node" in done).toBe(true);
    expect(aborted.state).toBe("completed");
    expect((await readAll((done as { node: { blobId: string } }).node.blobId)).equals(data)).toBe(true);
  });

  it("abort queues committed parts for deletion and refuses further chunks", async () => {
    const data = rand(PART + 1024 * 1024);
    const init = up.createUpload(rt, { name: "abort.bin", size: data.length, mime: null, parentId: "root" }) as { id: string };
    const ranges = planChunks(data.length, PART);
    await send(init.id, data, ranges[0]); // completes part 0 → commit in background
    await new Promise((r) => setTimeout(r, 50));
    const ref = sql("SELECT ref FROM upload_parts WHERE upload_id = ? AND idx = 0").pluck().get(init.id) as string;
    expect(ref).toBeTruthy();
    expect((await up.abortUpload(rt, init.id)).state).toBe("aborted");
    await expect(send(init.id, data, ranges[1])).rejects.toMatchObject({ status: 410 });
    await kickGc(rt);
    expect((rt.driver as unknown as { exists(r: string): boolean }).exists(ref)).toBe(false);
  });

  it("dedupes an in-flight upload atomically and never produces a second file", async () => {
    const data = rand(2 * 1024 * 1024 + 99);
    const first = await uploadAll(data, "original.bin");
    const init = up.createUpload(rt, { name: "copy.bin", size: data.length, mime: null, parentId: "root" }) as { id: string };
    await send(init.id, data, planChunks(data.length, PART)[0]);
    const res = up.dedupeUpload(rt, init.id, { sha256: sha(data).toString("hex") });
    expect(res.state).toBe("deduped");
    expect(res.node?.blobId).toBe(first.blobId);
    // Everything after that is a harmless no-op that reports the same file.
    expect(await send(init.id, data, planChunks(data.length, PART)[0])).toMatchObject({ skipped: true });
    const done = await up.completeUpload(rt, init.id, fileDigests(data, PART));
    expect("node" in done && done.node.id).toBe(res.node!.id);
    expect(up.dedupeUpload(rt, init.id, { sha256: sha(data).toString("hex") }).node?.id).toBe(res.node!.id);
    expect(sql("SELECT COUNT(*) FROM nodes WHERE name = 'copy.bin'").pluck().get()).toBe(1);
  });

  it("does not dedupe against unknown content", async () => {
    const init = up.createUpload(rt, { name: "unique.bin", size: 10, mime: null, parentId: "root" }) as { id: string };
    expect(up.dedupeUpload(rt, init.id, { sha256: "0".repeat(64) }).node).toBeNull();
    await up.abortUpload(rt, init.id);
  });

  it("reports missing ranges for resume and refuses to complete early", async () => {
    const data = rand(PART + 9 * 1024 * 1024);
    const init = up.createUpload(rt, { name: "resume.bin", size: data.length, mime: null, parentId: "root" }) as { id: string };
    const ranges = planChunks(data.length, PART);
    await send(init.id, data, ranges[0]);
    expect(up.uploadStatus(init.id).missing).toEqual(ranges.slice(1));
    const res = await up.completeUpload(rt, init.id, fileDigests(data, PART));
    expect(res).toEqual({ missing: ranges.slice(1), reason: "incomplete" });
    expect(up.uploadStatus(init.id).state).toBe("active"); // reopened
    const node = await complete(init.id, data);
    expect((await readAll(node.blobId!)).equals(data)).toBe(true);
  });

  it("handles zero-byte files as pure metadata", async () => {
    const res = up.createUpload(rt, { name: "empty.txt", size: 0, mime: "text/plain", parentId: "root" });
    expect("node" in res && res.node.size).toBe(0);
  });

  it("detects storage corruption on read instead of serving bad bytes", async () => {
    const data = rand(1024 * 1024 + 5);
    const node = await uploadAll(data, "rot.bin");
    const blob = blobs.loadBlob(node.blobId!)!;
    const { f } = JSON.parse(blob.parts[0].ref) as { f: string };
    const file = path.join(process.env.DATA_DIR!, "blobs", f);
    const bytes = fs.readFileSync(file);
    bytes[1234] ^= 0xff;
    fs.writeFileSync(file, bytes);
    const before = metrics.counters["integrity.mismatches"];
    await expect(readAll(node.blobId!)).rejects.toThrow(/SHA-256/);
    expect(metrics.counters["integrity.mismatches"]).toBeGreaterThan(before);
  });

  it("deleting a file removes its parts from storage immediately", async () => {
    const { deleteForever } = await import("@/server/nodes");
    const data = rand(PART + 100);
    const node = await uploadAll(data, "gone.bin");
    const refs = blobs.loadBlob(node.blobId!)!.parts.map((p) => p.ref);
    deleteForever([node.id]);
    await kickGc(rt);
    for (const r of refs) expect((rt.driver as unknown as { exists(r: string): boolean }).exists(r)).toBe(false);
    expect(sql("SELECT COUNT(*) FROM gc_queue").pluck().get()).toBe(0);
  });
});

describe("huge files (many parts)", () => {
  const pieceRows = (id: string) => sql("SELECT COUNT(*) FROM upload_pieces WHERE upload_id = ?").pluck().get(id) as number;
  const settle = () => new Promise((r) => setTimeout(r, 60));

  it("keeps per-piece rows only for parts in flight: durable parts are compacted", async () => {
    const data = rand(6 * PART + 1234); // 7 parts
    const init = up.createUpload(rt, { name: "many-parts.bin", size: data.length, mime: null, parentId: "root" }) as { id: string; partsInFlight: number };
    expect(init.partsInFlight).toBeGreaterThanOrEqual(3);
    const ranges = planChunks(data.length, PART, 2 * 1024 * 1024);
    let peak = 0;
    // Part by part, the way the browser's sliding window sends them.
    for (let part = 0; part < 7; part++) {
      await sendAll(init.id, data, ranges.filter((r) => r.part === part));
      await settle(); // the part commits in the background
      peak = Math.max(peak, pieceRows(init.id));
      const row = sql("SELECT ref, length(plain_hashes) AS plain, length(stored_hashes) AS stored FROM upload_parts WHERE upload_id = ? AND idx = ?").get(init.id, part) as {
        ref: string | null;
        plain: number | null;
        stored: number | null;
      };
      const pieces = Math.ceil(Math.min(PART, data.length - part * PART) / (512 * 1024));
      expect(row.ref).toBeTruthy();
      expect(row).toMatchObject({ plain: pieces * 32, stored: pieces * 32 });
    }
    // Never more than one part's worth of piece rows, although the file has 7 parts.
    expect(peak).toBe(0);
    const node = await complete(init.id, data);
    const blob = blobs.loadBlob(node.blobId!)!;
    expect(blob.partCount).toBe(7);
    expect(blob.parts.every((p) => p.pieceHashes?.length === Math.ceil(p.size / (512 * 1024)) * 32)).toBe(true);
    expect((await readAll(node.blobId!)).equals(data)).toBe(true);
    expect((await readAll(node.blobId!, 5 * PART - 3, 5 * PART + 3)).equals(data.subarray(5 * PART - 3, 5 * PART + 4))).toBe(true);
  });

  it("resumes after a reload: only what is missing is sent, finished parts stay", async () => {
    const data = rand(5 * PART + 777);
    const init = up.createUpload(rt, { name: "resume-many.bin", size: data.length, mime: null, parentId: "root" }) as { id: string };
    const ranges = planChunks(data.length, PART, 2 * 1024 * 1024);
    // Parts 0–1 fully sent, part 2 half sent; then the tab is closed.
    await sendAll(init.id, data, ranges.filter((r) => r.part < 2 || (r.part === 2 && r.offset < PART / 2)));
    await settle();
    const refsBefore = sql("SELECT ref FROM upload_parts WHERE upload_id = ? AND idx < 2 ORDER BY idx").pluck().all(init.id);
    // A new page asks where things stand: one range per run of missing bytes.
    const status = up.uploadStatus(init.id, { coarse: true });
    expect(status).toMatchObject({ state: "active", name: "resume-many.bin", size: data.length, partSize: PART, partCount: 6 });
    expect(status.missing).toEqual([
      { part: 2, offset: PART / 2, length: PART / 2 },
      { part: 3, offset: 0, length: PART },
      { part: 4, offset: 0, length: PART },
      { part: 5, offset: 0, length: 777 },
    ]);
    // The fine-grained form still splits at 8 MiB windows (older clients rely on it).
    expect(up.uploadStatus(init.id).missing.every((m) => m.length <= 8 * 1024 * 1024)).toBe(true);
    const sent = status.missing.reduce((n, m) => n + m.length, 0);
    await sendAll(init.id, data, status.missing.flatMap((m) => planChunks(m.length, m.length, 2 * 1024 * 1024).map((c) => ({ part: m.part, offset: m.offset + c.offset, length: c.length }))));
    const node = await complete(init.id, data);
    expect(sent).toBe(data.length - 2.5 * PART);
    expect(blobs.loadBlob(node.blobId!)!.parts.slice(0, 2).map((p) => p.ref)).toEqual(refsBefore); // not re-uploaded
    expect((await readAll(node.blobId!)).equals(data)).toBe(true);
  });

  it("proves assembly with one hash per part, and still accepts per-window proofs", async () => {
    const data = rand(2 * PART + 5);
    const a = up.createUpload(rt, { name: "roots.bin", size: data.length, mime: null, parentId: "root" }) as { id: string };
    await sendAll(a.id, data, planChunks(data.length, PART));
    const proof = fileDigests(data, PART);
    expect(proof.parts).toHaveLength(3);
    const wrong = { ...proof, parts: [proof.parts[0], proof.parts[2], proof.parts[1]] };
    const refused = await up.completeUpload(rt, a.id, wrong);
    expect("missing" in refused && refused.reason).toBe("checksum");
    expect(await complete(a.id, data)).toMatchObject({ size: data.length });

    const b = up.createUpload(rt, { name: "windows.bin", size: data.length, mime: null, parentId: "root" }) as { id: string };
    await sendAll(b.id, data, planChunks(data.length, PART));
    const res = await up.completeUpload(rt, b.id, legacyDigests(data, PART));
    expect("node" in res && res.node.size).toBe(data.length);
  });

  it("opens a session with tens of thousands of parts quickly", async () => {
    const size = 64 * 1024 ** 3 + 1; // 64 GiB + 1 byte → 16 385 parts of 4 MiB
    const t0 = performance.now();
    const s = up.createUpload(rt, { name: "sixty-four-gigs.bin", size, mime: null, parentId: "root" }) as { id: string; partCount: number };
    expect(s.partCount).toBe(16_385);
    const st = up.uploadStatus(s.id, { coarse: true });
    expect(st.missing).toHaveLength(16_385);
    expect(st.missing.at(-1)).toEqual({ part: 16_384, offset: 0, length: 1 });
    expect(performance.now() - t0).toBeLessThan(5000);
    await up.abortUpload(rt, s.id);
  });

  it("refuses sizes that can't be addressed exactly (over 2^53 − 1 bytes)", () => {
    expect(() => up.createUpload(rt, { name: "too-big.bin", size: Number.MAX_SAFE_INTEGER + 2, mime: null, parentId: "root" })).toThrow(/Invalid size/);
    expect(() => up.createUpload(rt, { name: "too-big.bin", size: 2 ** 64, mime: null, parentId: "root" })).toThrow(/Invalid size/);
  });
});
