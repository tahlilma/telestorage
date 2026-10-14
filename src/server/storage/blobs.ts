import "server-only";
import crypto from "node:crypto";
import { BLOCK_SIZE, PIECE_SIZE, config } from "../config";
import { sql } from "../db";
import { Background, Interactive, Normal, PriorityToken, type Priority } from "../lb";
import { log, metrics } from "../metrics";
import { sleep } from "../sem";
import type { BlockCache } from "./cache";
import { ctrTransform } from "./crypto";
import type { StorageDriver } from "./types";

export interface BlobPart {
  idx: number;
  size: number;
  ref: string;
  /** SHA-256 of every stored 512 KiB piece, concatenated (null for legacy parts). */
  pieceHashes: Buffer | null;
}

export interface BlobInfo {
  id: string;
  size: number;
  /** SHA-256 of the whole plaintext file (null for legacy blobs). */
  sha256: string | null;
  partSize: number;
  partCount: number;
  driver: string;
  encIv: Buffer | null;
  verifiedAt: number | null;
  parts: BlobPart[];
}

export interface Runtime {
  driver: StorageDriver;
  cache: BlockCache;
}

/** Who is reading: the owner, a public share-link visitor, or a background job. */
export type ReadClass = "owner" | "public" | "background";
const HEAD_PRIORITY: Record<ReadClass, Priority> = { owner: Interactive, public: Normal, background: Background };
const AHEAD_PRIORITY: Record<ReadClass, Priority> = { owner: Normal, public: Normal, background: Background };

/** Blob metadata is immutable once written, so it can be cached indefinitely. */
const g = globalThis as unknown as { __tsBlobMeta?: Map<string, BlobInfo> };
const blobMeta = (g.__tsBlobMeta ??= new Map());

export function loadBlob(id: string): BlobInfo | null {
  const cached = blobMeta.get(id);
  if (cached) return cached;
  const row = sql(
    `SELECT id, size, sha256, part_size AS partSize, part_count AS partCount, driver, enc_iv AS encIv, verified_at AS verifiedAt
     FROM blobs WHERE id = ?`,
  ).get(id) as Omit<BlobInfo, "parts"> | undefined;
  if (!row) return null;
  const parts = sql("SELECT idx, size, ref, piece_hashes AS pieceHashes FROM blob_parts WHERE blob_id = ? ORDER BY idx").all(
    id,
  ) as BlobPart[];
  const info: BlobInfo = { ...row, parts };
  blobMeta.set(id, info);
  if (blobMeta.size > 5000) blobMeta.delete(blobMeta.keys().next().value!);
  return info;
}

export function forgetBlobMeta(id: string) {
  blobMeta.delete(id);
}

/** The index was replaced: cached metadata may describe blobs it no longer has. */
export function forgetAllBlobMeta() {
  blobMeta.clear();
}

/** True if every 512 KiB piece of `data` (starting at piece `firstPiece`) matches its recorded SHA-256. */
export function verifyPieces(hashes: Buffer | null, firstPiece: number, data: Buffer): boolean {
  if (!hashes) return true;
  for (let off = 0, k = firstPiece; off < data.length; off += PIECE_SIZE, k++) {
    const expected = hashes.subarray(k * 32, k * 32 + 32);
    if (expected.length !== 32) return false;
    const actual = crypto.createHash("sha256").update(data.subarray(off, off + PIECE_SIZE)).digest();
    if (!actual.equals(expected)) return false;
  }
  return true;
}

function encryptionKeyFor(blob: BlobInfo): Buffer | null {
  if (!blob.encIv) return null;
  const key = config().encryptionKey;
  if (!key) throw new Error("This file is encrypted but ENCRYPTION_KEY is not configured");
  return key;
}

/** Fetches, verifies and decrypts global block `index` of a blob through the block cache. */
async function fetchBlock(rt: Runtime, blob: BlobInfo, index: number, token: PriorityToken): Promise<Buffer> {
  if (blob.driver !== rt.driver.name) {
    throw new Error(`File was stored with the "${blob.driver}" driver but the server runs "${rt.driver.name}"`);
  }
  const globalOffset = index * BLOCK_SIZE;
  const partIdx = Math.floor(globalOffset / blob.partSize);
  const offsetInPart = globalOffset - partIdx * blob.partSize;
  const part = blob.parts[partIdx];
  if (!part) throw new Error(`Blob ${blob.id} is missing part ${partIdx}`);
  const length = Math.min(BLOCK_SIZE, part.size - offsetInPart);
  const key = `${blob.id}/${partIdx}-${offsetInPart / BLOCK_SIZE}`;
  const raw = await rt.cache.get(key, (t) => rt.driver.readBlock(part.ref, offsetInPart, length, { token: t }), {
    persist: rt.driver.cacheable,
    token,
    // Stored bytes are checked against the SHA-256 recorded for each piece at upload time.
    verify: (buf) => buf.length === length && verifyPieces(part.pieceHashes, offsetInPart / PIECE_SIZE, buf),
  });
  const encKey = encryptionKeyFor(blob);
  return encKey ? ctrTransform(encKey, blob.encIv!, globalOffset, raw) : raw;
}

function markVerified(blob: BlobInfo) {
  blob.verifiedAt = Date.now();
  sql("UPDATE blobs SET verified_at = ?, corrupt_at = NULL WHERE id = ?").run(blob.verifiedAt, blob.id);
  metrics.inc("integrity.filesVerified");
}

function markCorrupt(blob: BlobInfo, actual: string) {
  sql("UPDATE blobs SET corrupt_at = ? WHERE id = ?").run(Date.now(), blob.id);
  metrics.inc("integrity.fileMismatches");
  log.error("integrity", `blob ${blob.id}: whole-file SHA-256 mismatch (expected ${blob.sha256}, got ${actual})`);
}

/**
 * How many blocks one stream may fetch ahead right now. Telegram answers a
 * 1 MiB block in roughly half a second, so throughput is window ÷ latency:
 * the window has to be wide to go fast. It is capped per stream
 * (STREAM_READAHEAD_BLOCKS) and shared out of one memory budget
 * (STREAM_BUFFER_MB), so ten parallel downloads can't hold gigabytes.
 */
function windowCap(): number {
  const { readahead, bufferBlocks } = config().stream;
  return Math.max(4, Math.min(readahead, Math.floor(bufferBlocks / Math.max(1, metrics.gauges.activeStreams))));
}

/**
 * Streams bytes [start, end] (inclusive) of a blob. Blocks are fetched in
 * parallel ahead of the consumer with an adaptive window: it starts at two
 * blocks (cheap for players that probe and abort) and doubles its lead as the
 * client keeps reading, like TCP slow start. The block the client is waiting
 * on runs at interactive priority (and is hedged on another bot if it
 * stalls); readahead runs at normal priority and is promoted as it becomes
 * the head. A complete read also verifies the whole-file SHA-256.
 */
export function openRangeStream(rt: Runtime, blob: BlobInfo, start: number, end: number, klass: ReadClass = "owner"): ReadableStream<Uint8Array> {
  if (blob.size === 0 || end < start) {
    return new ReadableStream({ start: (c) => c.close() });
  }
  const lastBlock = Math.floor(end / BLOCK_SIZE);
  let next = Math.floor(start / BLOCK_SIZE);
  let scheduled = next;
  let delivered = 0;
  let finished = false;
  const pending = new Map<number, { promise: Promise<Buffer>; token: PriorityToken }>();
  const t0 = performance.now();
  const hasher = start === 0 && end === blob.size - 1 && blob.sha256 ? crypto.createHash("sha256") : null;

  metrics.gauges.activeStreams++;
  const finish = () => {
    if (finished) return;
    finished = true;
    pending.clear();
    metrics.gauges.activeStreams--;
  };

  const schedule = () => {
    const window = Math.min(windowCap(), 2 + 2 * delivered);
    while (scheduled <= lastBlock && scheduled - next < window) {
      const token = new PriorityToken(scheduled === next ? HEAD_PRIORITY[klass] : AHEAD_PRIORITY[klass]);
      const promise = fetchBlock(rt, blob, scheduled, token);
      promise.catch(() => {}); // surfaced when awaited in order; avoid unhandled rejections after cancel
      pending.set(scheduled, { promise, token });
      scheduled++;
    }
  };

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          if (klass !== "background") metrics.lastForegroundAt = Date.now();
          schedule();
          const head = pending.get(next)!;
          head.token.raise(HEAD_PRIORITY[klass]); // the reader is now blocked on this one
          const buf = await head.promise;
          pending.delete(next);
          const blockStart = next * BLOCK_SIZE;
          const from = Math.max(start, blockStart) - blockStart;
          const to = Math.min(end + 1, blockStart + buf.length) - blockStart;
          if (delivered === 0) metrics.latency.timeToFirstByte.record(performance.now() - t0);
          const chunk = new Uint8Array(buf.buffer, buf.byteOffset + from, to - from);
          hasher?.update(chunk);
          controller.enqueue(chunk);
          metrics.inc("http.bytesOut", to - from);
          delivered++;
          next++;
          if (next > lastBlock) {
            if (hasher) {
              const actual = hasher.digest("hex");
              if (actual === blob.sha256) {
                if (!blob.verifiedAt) markVerified(blob);
              } else {
                markCorrupt(blob, actual);
              }
            }
            controller.close();
            finish();
          } else {
            schedule();
          }
        } catch (e) {
          finish();
          controller.error(e);
        }
      },
      cancel() {
        finish();
      },
    },
    { highWaterMark: 0 },
  );
}

/** Warms the cache with the first blocks of a blob (e.g. the next file of a ZIP stream). */
export function prefetchBlob(rt: Runtime, blob: BlobInfo, blocks = 4) {
  const last = Math.min(Math.ceil(blob.size / BLOCK_SIZE), blocks);
  for (let i = 0; i < last; i++) fetchBlock(rt, blob, i, new PriorityToken(Background)).catch(() => {});
}

/** Reads a whole (small) blob into memory, e.g. for backups. */
export async function readBlob(rt: Runtime, blob: BlobInfo, maxBytes = 64 * 1024 * 1024, klass: ReadClass = "background"): Promise<Buffer> {
  if (blob.size > maxBytes) throw new Error("Blob too large to buffer");
  const chunks: Uint8Array[] = [];
  const reader = openRangeStream(rt, blob, 0, blob.size - 1, klass).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Background read-back verification ("scrub"): reads every block of a blob
 * at background priority, checks each piece hash and the whole-file SHA-256,
 * and yields to foreground traffic whenever `busy()` reports activity.
 */
export async function scrubBlob(
  rt: Runtime,
  blob: BlobInfo,
  opts: { bytesPerSec: number; busy: () => boolean; cancelled: () => boolean },
): Promise<"verified" | "corrupt" | "skipped"> {
  // Nothing to verify against for legacy blobs; never claim they are verified.
  if (!blob.sha256) return "skipped";
  const hasher = crypto.createHash("sha256");
  const blocks = Math.ceil(blob.size / BLOCK_SIZE);
  for (let i = 0; i < blocks; i++) {
    while (opts.busy()) {
      if (opts.cancelled()) return "skipped";
      await sleep(1000);
    }
    if (opts.cancelled()) return "skipped";
    const t0 = performance.now();
    const buf = await fetchBlock(rt, blob, i, new PriorityToken(Background));
    hasher.update(buf);
    metrics.inc("scrub.bytes", buf.length);
    const budgetMs = (buf.length / opts.bytesPerSec) * 1000;
    const spent = performance.now() - t0;
    if (budgetMs > spent) await sleep(budgetMs - spent);
  }
  const actual = hasher.digest("hex");
  if (actual === blob.sha256) {
    markVerified(blob);
    return "verified";
  }
  markCorrupt(blob, actual);
  return "corrupt";
}
