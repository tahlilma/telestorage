import "server-only";
import crypto from "node:crypto";
import {
  PIECE_SIZE,
  WINDOW_PIECES,
  WINDOW_SIZE,
  partSizes,
  piecesIn,
  windowLayout,
  windowsOfPart,
  type CompleteRetry,
  type MissingRange,
  type UploadState,
} from "@/lib/protocol";
import type { ConflictPolicy, DriveNode, UploadInit, UploadOutcome } from "@/lib/types";
import { logActivity } from "../activity";
import { admitUploadBytes } from "../admission";
import { config } from "../config";
import { sql, tx } from "../db";
import { emitNodes } from "../events";
import { HttpError, badRequest, conflict, notFound } from "../http";
import { newId } from "../ids";
import { Normal, PriorityToken } from "../lb";
import { log, metrics } from "../metrics";
import { cleanName, fileNamed, getNode, placeUpload } from "../nodes";
import { recordReceived } from "../shares";
import type { Runtime } from "./blobs";
import { ctrTransform, newIv } from "./crypto";
import { GoneError, type PartUploadState } from "./types";

/**
 * Upload sessions are an explicit state machine persisted in SQLite:
 *
 *   active ──complete()──▶ completing ──▶ completed
 *     │  ▲                     │
 *     │  └── missing/checksum ─┘
 *     ├──dedupe()──▶ deduped
 *     └──abort()───▶ aborted
 *
 * Chunks are only accepted while `active`; completion, dedup and abort are
 * serialised per session, and every transition re-reads the state inside a
 * transaction, so no interleaving of retries, cancels and duplicate requests
 * can produce a duplicate file, a lost part or a dangling Telegram message.
 */

interface Meta {
  blobId: string;
  parentId: string;
  name: string;
  /** What to do if the name is taken when the file lands (sessions from before v3: keep both). */
  policy?: ConflictPolicy;
  /** When the photo/video was taken, from its metadata (read in the browser). */
  takenAt?: number | null;
  /** Uploaded by a visitor through this file request (share id), with the name they gave. */
  via?: string;
  from?: string | null;
  mime: string | null;
  size: number;
  partSize: number;
  encIv: string | null;
  driver: string;
}

interface Live {
  id: string;
  meta: Meta;
  encIv: Buffer | null;
  partStarts: Map<number, Promise<PartUploadState>>;
  commits: Map<number, Promise<void>>;
  completing: Promise<UploadResult | CompleteRetry> | null;
  writers: number;
  idleWaiters: (() => void)[];
  /** Commits refused because Telegram lost pieces, per part (see commitPart). */
  misses: Map<number, number>;
}

const g = globalThis as unknown as { __tsUploadLive?: Map<string, Live> };
const live = (g.__tsUploadLive ??= new Map());

const now = () => Date.now();

function readState(id: string): UploadState | undefined {
  return (sql("SELECT state FROM upload_sessions WHERE id = ?").get(id) as { state: UploadState } | undefined)?.state;
}

function setState(id: string, state: UploadState, result?: unknown) {
  sql("UPDATE upload_sessions SET state = ?, result = COALESCE(?, result), updated_at = ? WHERE id = ?").run(
    state,
    result === undefined ? null : JSON.stringify(result),
    now(),
    id,
  );
}

export interface UploadResult {
  node: DriveNode;
  outcome: UploadOutcome;
}

function storedResult(id: string): UploadResult {
  const row = sql("SELECT result FROM upload_sessions WHERE id = ?").get(id) as { result: string | null } | undefined;
  const parsed = row?.result ? (JSON.parse(row.result) as DriveNode | UploadResult) : null;
  if (!parsed) throw new HttpError(500, "Upload finished but its result was not recorded");
  // Sessions finished before v3 stored the bare node.
  const result: UploadResult = "outcome" in parsed && "node" in parsed ? parsed : { node: parsed as DriveNode, outcome: "created" };
  // Prefer the live node (it may have been renamed or moved since).
  return { node: getNode(result.node.id) ?? result.node, outcome: result.outcome };
}

/** Feed entry for a landed upload: identical re-uploads are reported as duplicates. */
function recordLanding(r: UploadResult, size: number, via?: { shareId: string; from: string | null }) {
  if (via) {
    // A visitor sent this through a file request: counted on the request, exactly once.
    if (r.outcome !== "identical" && r.outcome !== "skipped") recordReceived(via.shareId, r.node, via.from);
    return;
  }
  if (r.outcome === "identical") {
    metrics.inc("uploads.identical");
    logActivity({ kind: "duplicate", name: r.node.name, nodeId: r.node.id, parentId: r.node.parentId });
    return;
  }
  if (r.outcome === "renamed") metrics.inc("uploads.renamed");
  if (r.outcome === "replaced") {
    metrics.inc("uploads.replaced");
    logActivity({ kind: "version", name: r.node.name, nodeId: r.node.id, parentId: r.node.parentId, detail: { bytes: size } });
    return;
  }
  logActivity({ kind: "upload", name: r.node.name, nodeId: r.node.id, parentId: r.node.parentId, detail: { bytes: size } });
}

const parsePolicy = (v: unknown): ConflictPolicy => (v === "replace" || v === "skip" ? v : "keep");

/** A plausible capture time (1970 … tomorrow), or null. */
const parseTakenAt = (v: unknown): number | null =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v < Date.now() + 86_400_000 ? v : null;

function load(id: string): Live {
  const existing = live.get(id);
  if (existing) return existing;
  const row = sql("SELECT meta FROM upload_sessions WHERE id = ?").get(id) as { meta: string } | undefined;
  if (!row) throw notFound("Upload session not found or expired");
  const meta = JSON.parse(row.meta) as Meta;
  const l: Live = {
    id,
    meta,
    encIv: meta.encIv ? Buffer.from(meta.encIv, "base64") : null,
    partStarts: new Map(),
    commits: new Map(),
    completing: null,
    writers: 0,
    idleWaiters: [],
    misses: new Map(),
  };
  live.set(id, l);
  return l;
}

function partRow(id: string, idx: number) {
  return sql("SELECT size, driver_state AS driverState, ref FROM upload_parts WHERE upload_id = ? AND idx = ?").get(id, idx) as
    | { size: number; driverState: string | null; ref: string | null }
    | undefined;
}

function countPieces(id: string, part: number): number {
  return sql("SELECT COUNT(*) FROM upload_pieces WHERE upload_id = ? AND part = ?").pluck().get(id, part) as number;
}

function partName(l: Live, idx: number, parts: number) {
  // With encryption on, keep the channel free of real file names.
  const base = l.encIv ? `${l.meta.blobId}.bin` : l.meta.name;
  return parts > 1 ? `${base}.${String(idx + 1).padStart(3, "0")}` : base;
}

function partInfo(l: Live, idx: number, size: number) {
  const parts = Math.ceil(l.meta.size / l.meta.partSize);
  return {
    blobId: l.meta.blobId,
    index: idx,
    size,
    fileName: partName(l, idx, parts),
    caption: `#telestorage ${JSON.stringify({ b: l.meta.blobId, p: idx, n: parts, s: l.meta.size, e: l.encIv ? 1 : 0 })}`,
  };
}

function waitForWriters(l: Live, timeoutMs: number): Promise<void> {
  if (l.writers === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, timeoutMs);
    l.idleWaiters.push(() => {
      clearTimeout(t);
      resolve();
    });
  });
}

function writerDone(l: Live) {
  l.writers--;
  if (l.writers === 0) for (const w of l.idleWaiters.splice(0)) w();
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

export function createUpload(
  rt: Runtime,
  input: { name: unknown; size: unknown; mime: unknown; parentId: unknown; onConflict?: unknown; takenAt?: unknown },
  /** Set by the file-request routes only: who the upload is for. */
  opts: { via?: string; from?: string | null } = {},
): UploadInit | UploadResult {
  const name = cleanName(input.name);
  const policy = parsePolicy(input.onConflict);
  const takenAt = parseTakenAt(input.takenAt);
  const size = Number(input.size);
  if (!Number.isSafeInteger(size) || size < 0) throw badRequest("Invalid size");
  const parentId = typeof input.parentId === "string" ? input.parentId : "root";
  const mime = typeof input.mime === "string" && input.mime.length < 200 && input.mime ? input.mime : null;
  const cfg = config();
  const blobId = newId(16);

  // "Skip if it exists": decided before a single byte is sent.
  if (policy === "skip") {
    const existing = fileNamed(parentId, name);
    if (existing) {
      metrics.inc("uploads.skipped");
      return { node: existing, outcome: "skipped" };
    }
  }

  // Telegram rejects empty documents, so zero-byte files are pure metadata.
  if (size === 0) {
    const emptySha = crypto.createHash("sha256").digest("hex");
    const result = tx(() => {
      const placed = placeUpload({
        parentId,
        name,
        size: 0,
        mime,
        blobId,
        sha256: emptySha,
        policy,
        takenAt,
        onCreate: () =>
          sql(
            "INSERT INTO blobs (id, size, sha256, part_size, part_count, driver, enc_iv, created_at, verified_at) VALUES (?, 0, ?, ?, 0, ?, NULL, ?, ?)",
          ).run(blobId, emptySha, PIECE_SIZE, rt.driver.name, now(), now()),
      });
      const r: UploadResult = { node: placed.node, outcome: placed.outcome };
      recordLanding(r, 0, opts.via ? { shareId: opts.via, from: opts.from ?? null } : undefined);
      return { ...r, replaced: placed.replaced };
    });
    announceLanding(result);
    return { node: result.node, outcome: result.outcome };
  }

  const partSize = cfg.tg.partSize;
  const encIv = cfg.encryptionKey ? newIv() : null;
  const meta: Meta = {
    blobId,
    parentId,
    name,
    policy,
    takenAt,
    via: opts.via,
    from: opts.from ?? null,
    mime,
    size,
    partSize,
    encIv: encIv?.toString("base64") ?? null,
    driver: rt.driver.name,
  };
  const id = newId(16);
  const sizes = partSizes(size, partSize);
  tx(() => {
    sql("INSERT INTO upload_sessions (id, state, meta, created_at, updated_at) VALUES (?, 'active', ?, ?, ?)").run(id, JSON.stringify(meta), now(), now());
    const insertPart = sql("INSERT INTO upload_parts (upload_id, idx, size) VALUES (?, ?, ?)");
    sizes.forEach((s, i) => insertPart.run(id, i, s));
  });
  metrics.gauges.activeUploads = activeCount();
  return { id, partSize, pieceSize: PIECE_SIZE, chunkSize: WINDOW_SIZE, partCount: sizes.length, partsInFlight: partsInFlight(rt) };
}

/**
 * Parts a client should keep open at once: two per bot keeps every bot busy
 * (one part sending while another commits). Finishing parts in order means a
 * 1 TB upload interrupted after 600 GB has ~600 GB of durable posts to resume
 * from, instead of thousands of half-sent parts waiting for the end.
 */
export function partsInFlight(rt: Runtime) {
  return Math.max(3, Math.min(16, rt.driver.status().bots.length * 2));
}

function activeCount() {
  return sql("SELECT COUNT(*) FROM upload_sessions WHERE state IN ('active', 'completing')").pluck().get() as number;
}

// ---------------------------------------------------------------------------
// chunks
// ---------------------------------------------------------------------------

/** Begins the part on the driver lazily, so bots are assigned only when data arrives. */
async function ensurePartStarted(rt: Runtime, l: Live, idx: number, size: number): Promise<PartUploadState> {
  const row = partRow(l.id, idx);
  if (row?.driverState) return JSON.parse(row.driverState) as PartUploadState;
  let p = l.partStarts.get(idx);
  if (!p) {
    p = rt.driver.beginPart(partInfo(l, idx, size)).then((state) => {
      sql("UPDATE upload_parts SET driver_state = ? WHERE upload_id = ? AND idx = ? AND driver_state IS NULL").run(JSON.stringify(state), l.id, idx);
      return JSON.parse(partRow(l.id, idx)!.driverState!) as PartUploadState;
    });
    l.partStarts.set(idx, p);
    p.then(
      () => l.partStarts.delete(idx),
      () => l.partStarts.delete(idx),
    );
  }
  return p;
}

/**
 * Throws away a part's progress (and its committed copy, if any) so it can be
 * uploaded again from scratch — used when the part's bot is gone for good or
 * when assembly verification proves its bytes wrong.
 */
function resetPart(rt: Runtime, l: Live, idx: number, reason: string) {
  const row = partRow(l.id, idx);
  tx(() => {
    if (row?.ref) {
      sql("INSERT INTO gc_queue (driver, blob_id, ref, next_at) VALUES (?, ?, ?, ?)").run(l.meta.driver, l.meta.blobId, row.ref, now());
    }
    sql("UPDATE upload_parts SET driver_state = NULL, ref = NULL, plain_hashes = NULL, stored_hashes = NULL WHERE upload_id = ? AND idx = ?").run(l.id, idx);
    sql("DELETE FROM upload_pieces WHERE upload_id = ? AND part = ?").run(l.id, idx);
  });
  if (row?.driverState) void rt.driver.abortPart(JSON.parse(row.driverState)).catch(() => {});
  metrics.inc("upload.partsRedone");
  log.warn("upload", `${l.meta.name}: part ${idx} reset (${reason})`);
}

/** Parses RFC 9530 `Content-Digest: sha-256=:<base64>:` (or a hex `X-Chunk-SHA256`). */
export function parseDigest(contentDigest: string | null, legacyHex: string | null): Buffer | null {
  const m = contentDigest ? /sha-256=:([A-Za-z0-9+/=]+):/i.exec(contentDigest) : null;
  if (m) {
    const b = Buffer.from(m[1], "base64");
    if (b.length === 32) return b;
    throw badRequest("Malformed Content-Digest");
  }
  if (legacyHex) {
    if (!/^[0-9a-f]{64}$/i.test(legacyHex)) throw badRequest("Malformed X-Chunk-SHA256");
    return Buffer.from(legacyHex, "hex");
  }
  return null;
}

/**
 * Streams one HTTP chunk into storage. The body is cut into 512 KiB pieces as
 * it arrives; each piece is hashed (plaintext and stored form), optionally
 * encrypted, and uploaded with bounded parallelism. Nothing is recorded until
 * the whole body has arrived AND matched the client's SHA-256 digest, so a
 * corrupted or truncated chunk leaves no trace and is simply resent.
 */
export async function writeChunk(
  rt: Runtime,
  id: string,
  partIdx: number,
  offset: number,
  body: ReadableStream<Uint8Array> | null,
  opts: { digest: Buffer | null; contentLength: number | null },
): Promise<{ received: number; pieces: number; skipped?: boolean }> {
  const l = load(id);
  const state = readState(id);
  if (state === "completed" || state === "deduped") return { received: 0, pieces: 0, skipped: true };
  if (state === "aborted") throw new HttpError(410, "This upload was cancelled");
  if (state === "completing") throw conflict("Upload is being finalised");
  if (!body) throw badRequest("Missing body");

  const row = partRow(id, partIdx);
  if (!row) throw badRequest("Invalid part index");
  if (offset % PIECE_SIZE !== 0 || offset < 0 || offset >= row.size) throw badRequest("Chunk offset must be piece-aligned and inside the part");
  if (opts.contentLength !== null && offset + opts.contentLength > row.size) throw badRequest("Chunk extends past the end of the part");
  if (row.ref) {
    // Part already durable (e.g. a retry of a chunk that did land): drain and acknowledge.
    await body.cancel().catch(() => {});
    return { received: 0, pieces: 0, skipped: true };
  }

  const release = await admitUploadBytes(opts.contentLength ?? WINDOW_SIZE);
  metrics.lastForegroundAt = Date.now();
  l.writers++;
  try {
    let driverState: PartUploadState;
    try {
      driverState = await ensurePartStarted(rt, l, partIdx, row.size);
    } catch (e) {
      if (e instanceof GoneError) {
        resetPart(rt, l, partIdx, e.message);
        throw conflict("Storage for this part moved — the client will resend it");
      }
      throw e;
    }

    const totalPieces = piecesIn(row.size);
    const key = config().encryptionKey;
    const token = new PriorityToken(Normal);
    const parallel = config().uploads.piecesPerChunk;
    const chunkHash = crypto.createHash("sha256");
    const recorded: { piece: number; plain: Buffer; stored: Buffer }[] = [];
    const inflight = new Set<Promise<void>>();
    let failure: unknown = null;
    let pieceIdx = offset / PIECE_SIZE;
    let buf = Buffer.allocUnsafe(Math.min(PIECE_SIZE, row.size - offset));
    let fill = 0;
    let received = 0;

    const dispatch = (index: number, data: Buffer) => {
      const p = (async () => {
        const plain = crypto.createHash("sha256").update(data).digest();
        const payload = l.encIv && key ? ctrTransform(key, l.encIv, partIdx * l.meta.partSize + index * PIECE_SIZE, data) : data;
        const stored = l.encIv && key ? crypto.createHash("sha256").update(payload).digest() : plain;
        await rt.driver.writePiece(driverState, index, totalPieces, payload, { token });
        recorded.push({ piece: index, plain, stored });
      })();
      inflight.add(p);
      p.then(
        () => inflight.delete(p),
        (e) => {
          inflight.delete(p);
          failure ??= e;
        },
      );
    };

    try {
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
        if (failure) break;
        received += chunk.length;
        chunkHash.update(chunk);
        metrics.inc("http.bytesIn", chunk.length);
        let pos = 0;
        while (pos < chunk.length) {
          if (pieceIdx >= totalPieces) throw badRequest("Chunk extends past the end of the part");
          const n = Math.min(buf.length - fill, chunk.length - pos);
          buf.set(chunk.subarray(pos, pos + n), fill);
          fill += n;
          pos += n;
          if (fill === buf.length) {
            dispatch(pieceIdx, buf);
            pieceIdx++;
            fill = 0;
            buf = Buffer.allocUnsafe(Math.max(0, Math.min(PIECE_SIZE, row.size - pieceIdx * PIECE_SIZE)));
            // Bounded parallelism doubles as TCP back-pressure on the client.
            while (inflight.size >= parallel && !failure) await Promise.race(inflight).catch(() => {});
          }
        }
      }
    } catch (e) {
      failure ??= e;
    }
    await Promise.allSettled([...inflight]);
    if (failure) {
      if (failure instanceof GoneError) {
        resetPart(rt, l, partIdx, failure.message);
        throw conflict("Storage for this part moved — the client will resend it");
      }
      throw failure;
    }
    if (fill > 0) throw badRequest("Chunk ended mid-piece (connection interrupted?)");
    if (opts.digest && !chunkHash.digest().equals(opts.digest)) {
      metrics.inc("upload.digestMismatches");
      throw new HttpError(422, "Chunk failed its SHA-256 check — resend it");
    }

    // Record atomically, and only if nobody completed/cancelled the session — or
    // reset this part onto a new storage session — while the chunk was in flight.
    const usedState = JSON.stringify(driverState);
    const ok = tx(() => {
      if (readState(id) !== "active") return false;
      const current = partRow(id, partIdx);
      if (current?.driverState !== usedState) return false;
      if (current.ref) return true; // a duplicate of a chunk that already landed: the part is durable
      const insert = sql("INSERT OR REPLACE INTO upload_pieces (upload_id, part, piece, plain_sha256, stored_sha256) VALUES (?, ?, ?, ?, ?)");
      for (const r of recorded) insert.run(id, partIdx, r.piece, r.plain, r.stored);
      sql("UPDATE upload_sessions SET updated_at = ? WHERE id = ?").run(now(), id);
      return true;
    });
    if (!ok) throw conflict("Upload state changed while this chunk was in flight");
    metrics.inc("upload.chunks");

    if (countPieces(id, partIdx) === totalPieces) {
      // Commit in the background so the chunk response isn't held up by rate limits.
      void commitPart(rt, l, partIdx).catch((e) => log.warn("upload", `${l.meta.name}: commit of part ${partIdx} deferred: ${(e as Error).message}`));
    }
    return { received, pieces: recorded.length };
  } finally {
    writerDone(l);
    release();
  }
}

/** Commits one complete part. One commit per part, however many callers race here. */
function commitPart(rt: Runtime, l: Live, idx: number): Promise<void> {
  const existing = l.commits.get(idx);
  if (existing) return existing;
  const p = (async () => {
    const row = partRow(l.id, idx);
    if (!row || row.ref || !row.driverState) return;
    const total = piecesIn(row.size);
    if (countPieces(l.id, idx) !== total) return;
    try {
      const ref = await rt.driver.commitPart(JSON.parse(row.driverState), partInfo(l, idx, row.size), total);
      const stillWanted = tx(() => {
        const st = readState(l.id);
        if (st !== "active" && st !== "completing") return false;
        // The part was reset (or lost pieces) while the commit was in flight.
        if (partRow(l.id, idx)?.driverState !== row.driverState || countPieces(l.id, idx) !== total) return false;
        sql("UPDATE upload_parts SET ref = ? WHERE upload_id = ? AND idx = ?").run(ref, l.id, idx);
        compactPart(l.id, idx);
        return true;
      });
      // Session was cancelled/deduped while we were committing: the new message is garbage.
      if (!stillWanted) sql("INSERT INTO gc_queue (driver, blob_id, ref, next_at) VALUES (?, ?, ?, ?)").run(l.meta.driver, l.meta.blobId, ref, now());
      l.misses.delete(idx);
    } catch (e) {
      // Telegram reports pieces it never received. Usually a piece went
      // missing: forget it so the client resends it. Refusal after refusal
      // for the same part means Telegram dropped the whole unfinished upload
      // (it keeps those only for a while, e.g. across a long pause), so the
      // part starts over in one go instead of its pieces turning up missing
      // one at a time.
      const missing = /FILE_PART_(\d+)_MISSING/.exec(e instanceof Error ? e.message : String(e));
      if (missing) {
        const strikes = (l.misses.get(idx) ?? 0) + 1;
        l.misses.set(idx, strikes);
        if (strikes >= 3) {
          l.misses.delete(idx);
          resetPart(rt, l, idx, "Telegram no longer has the unfinished part");
        } else {
          sql("DELETE FROM upload_pieces WHERE upload_id = ? AND part = ? AND piece = ?").run(l.id, idx, Number(missing[1]));
          metrics.inc("upload.piecesResent");
          log.warn("upload", `${l.meta.name}: storage lost part ${idx} piece ${missing[1]} — will be resent`);
        }
      }
      throw e;
    } finally {
      l.commits.delete(idx);
    }
  })();
  l.commits.set(idx, p);
  return p;
}

/**
 * A durable part no longer needs a row per piece: its checksums are folded
 * into the part's row (32 bytes per 512 KiB piece, plaintext and stored form).
 * The database then grows with parts, not pieces, while a multi-terabyte
 * upload runs. Called inside the commit transaction.
 */
function compactPart(id: string, idx: number) {
  const rows = sql("SELECT plain_sha256 AS p, stored_sha256 AS s FROM upload_pieces WHERE upload_id = ? AND part = ? ORDER BY piece").all(id, idx) as {
    p: Buffer;
    s: Buffer;
  }[];
  sql("UPDATE upload_parts SET plain_hashes = ?, stored_hashes = ? WHERE upload_id = ? AND idx = ?").run(
    Buffer.concat(rows.map((r) => r.p)),
    Buffer.concat(rows.map((r) => r.s)),
    id,
    idx,
  );
  sql("DELETE FROM upload_pieces WHERE upload_id = ? AND part = ?").run(id, idx);
}

/**
 * A part's piece checksums, concatenated (32 bytes each): from the compacted
 * row once the part is durable, otherwise from the piece rows. Missing pieces
 * read as zeros, which never match a real hash.
 */
function pieceHashes(id: string, idx: number, size: number, which: "plain" | "stored"): Buffer {
  const total = piecesIn(size);
  const packed = sql(`SELECT ${which}_hashes FROM upload_parts WHERE upload_id = ? AND idx = ?`).pluck().get(id, idx) as Buffer | null | undefined;
  if (packed && packed.length === total * 32) return packed;
  const out = Buffer.alloc(total * 32);
  const rows = sql(`SELECT piece, ${which}_sha256 AS h FROM upload_pieces WHERE upload_id = ? AND part = ?`).all(id, idx) as { piece: number; h: Buffer }[];
  for (const r of rows) if (r.piece < total) r.h.copy(out, r.piece * 32);
  return out;
}

// ---------------------------------------------------------------------------
// status / verification
// ---------------------------------------------------------------------------

/**
 * Exactly the bytes the client still has to send, for every uncommitted part:
 * runs of missing pieces, split at window boundaries so no request exceeds
 * one window (8 MiB). A resumed upload never re-sends what already landed.
 * `coarse` leaves each run whole (the client cuts it into requests itself),
 * which keeps the answer small when resuming a multi-terabyte file.
 */
function missingRanges(id: string, coarse = false): MissingRange[] {
  const parts = sql("SELECT idx, size, ref FROM upload_parts WHERE upload_id = ? ORDER BY idx").all(id) as { idx: number; size: number; ref: string | null }[];
  const have = new Map<number, Set<number>>();
  for (const r of sql("SELECT part, piece FROM upload_pieces WHERE upload_id = ?").all(id) as { part: number; piece: number }[]) {
    let s = have.get(r.part);
    if (!s) have.set(r.part, (s = new Set()));
    s.add(r.piece);
  }
  const out: MissingRange[] = [];
  for (const p of parts) {
    if (p.ref) continue;
    const got = have.get(p.idx) ?? new Set<number>();
    const total = piecesIn(p.size);
    for (let i = 0; i < total; ) {
      if (got.has(i)) {
        i++;
        continue;
      }
      const start = i;
      const windowEnd = coarse ? total : Math.min(total, (Math.floor(i / WINDOW_PIECES) + 1) * WINDOW_PIECES);
      while (i < windowEnd && !got.has(i)) i++;
      const off = start * PIECE_SIZE;
      out.push({ part: p.idx, offset: off, length: Math.min(i * PIECE_SIZE, p.size) - off });
    }
  }
  return out;
}

/** Window hashes of one part (the hash tree in protocol.ts), from its plaintext piece hashes. */
function partWindows(id: string, part: number, size: number): Buffer[] {
  const hashes = pieceHashes(id, part, size, "plain");
  const out: Buffer[] = [];
  let first = 0;
  for (const n of windowsOfPart(size)) {
    out.push(crypto.createHash("sha256").update(hashes.subarray(first * 32, (first + n) * 32)).digest());
    first += n;
  }
  return out;
}

/** Part root = SHA-256 of the part's window hashes. */
const partRoot = (windows: Buffer[]) => crypto.createHash("sha256").update(Buffer.concat(windows)).digest();

/**
 * Visitors of a file request may only touch uploads they started through
 * that same request. Anything else is "not found", never "forbidden".
 */
export function requireRequestUpload(id: string, shareId: string) {
  let meta: Meta;
  try {
    meta = load(id).meta;
  } catch {
    throw notFound("Upload session not found or expired");
  }
  if (meta.via !== shareId) throw notFound("Upload session not found or expired");
}

/** Where an upload stands; enough for a reloaded page to pick it up again. */
export function uploadStatus(id: string, opts: { coarse?: boolean } = {}) {
  const l = load(id);
  const state = readState(id) ?? "aborted";
  return {
    id,
    state,
    name: l.meta.name,
    parentId: l.meta.parentId,
    size: l.meta.size,
    partSize: l.meta.partSize,
    partCount: Math.ceil(l.meta.size / l.meta.partSize),
    pieceSize: PIECE_SIZE,
    chunkSize: WINDOW_SIZE,
    missing: state === "active" ? missingRanges(id, opts.coarse) : [],
  };
}

// ---------------------------------------------------------------------------
// complete
// ---------------------------------------------------------------------------

export async function completeUpload(
  rt: Runtime,
  id: string,
  body: { sha256?: unknown; parts?: unknown; windows?: unknown },
): Promise<UploadResult | CompleteRetry> {
  const l = load(id);
  // Concurrent completes (a client retry racing the original) share one execution.
  if (l.completing) return l.completing;
  l.completing = (async () => {
    try {
      return await finalize(rt, l, body);
    } finally {
      l.completing = null;
    }
  })();
  return l.completing;
}

function announceLanding(r: UploadResult & { replaced?: string }) {
  emitNodes("upload", {
    parents: [r.node.parentId],
    ids: [r.node.id, ...(r.replaced ? [r.replaced] : [])],
    removed: r.replaced ? [r.replaced] : [],
  });
}

const isHexList = (v: unknown): v is string[] => Array.isArray(v) && v.every((w) => typeof w === "string" && /^[0-9a-f]{64}$/.test(w));

async function finalize(rt: Runtime, l: Live, body: { sha256?: unknown; parts?: unknown; windows?: unknown }): Promise<UploadResult | CompleteRetry> {
  const id = l.id;
  const state = readState(id);
  if (state === "completed" || state === "deduped") return storedResult(id);
  if (state === "aborted" || state === undefined) throw new HttpError(410, "This upload was cancelled");

  const sha256 = typeof body.sha256 === "string" && /^[0-9a-f]{64}$/.test(body.sha256) ? body.sha256 : null;
  // Proof of assembly: one root per part (current clients) or every window hash (older ones).
  const roots = body.parts ?? null;
  const windows = body.windows ?? null;
  if (roots !== null && !isHexList(roots)) throw badRequest("parts must be SHA-256 hex strings");
  if (windows !== null && !isHexList(windows)) throw badRequest("windows must be SHA-256 hex strings");

  setState(id, "completing"); // from here on, new chunks are refused
  const reopen = (retry: CompleteRetry) => {
    setState(id, "active");
    return retry;
  };
  await waitForWriters(l, 60_000);
  await Promise.allSettled([...l.commits.values()]);

  // 1. Coverage: every piece of every uncommitted part must be present.
  let missing = missingRanges(id);
  if (missing.length) return reopen({ missing, reason: "incomplete" });

  // 2. Assembly verification: the server's view of the file must hash to
  //    exactly what the browser computed from the original, part by part.
  let verified = false;
  if (roots || windows) {
    const sizes = partSizes(l.meta.size, l.meta.partSize);
    const layout = windows ? windowLayout(l.meta.size, l.meta.partSize) : [];
    if (roots && roots.length !== sizes.length) throw badRequest(`Expected ${sizes.length} part hashes, got ${roots.length}`);
    if (windows && windows.length !== layout.length) throw badRequest(`Expected ${layout.length} window hashes, got ${windows.length}`);
    // Damaged ranges: a whole part (root mismatch) or single windows (older clients).
    const bad: { part: number; firstPiece: number; pieces: number }[] = [];
    let w = 0;
    for (let part = 0; part < sizes.length; part++) {
      const ours = partWindows(id, part, sizes[part]);
      if (roots) {
        if (!partRoot(ours).equals(Buffer.from(roots[part], "hex"))) bad.push({ part, firstPiece: 0, pieces: piecesIn(sizes[part]) });
        continue;
      }
      for (const mine of ours) {
        const slot = layout[w];
        if (!mine.equals(Buffer.from(windows![w], "hex"))) bad.push({ part, firstPiece: slot.firstPiece, pieces: slot.pieces });
        w++;
      }
    }
    if (bad.length) {
      metrics.inc("upload.windowMismatches", bad.length);
      log.warn("upload", `${l.meta.name}: ${bad.length} range(s) failed assembly verification`);
      for (const part of new Set(bad.map((b) => b.part))) {
        if (partRow(id, part)?.ref) {
          resetPart(rt, l, part, "assembly checksum mismatch in a committed part");
        } else {
          const del = sql("DELETE FROM upload_pieces WHERE upload_id = ? AND part = ? AND piece >= ? AND piece < ?");
          for (const b of bad.filter((x) => x.part === part)) del.run(id, part, b.firstPiece, b.firstPiece + b.pieces);
        }
      }
      return reopen({ missing: missingRanges(id), reason: "checksum" });
    }
    verified = true;
  }

  // 3. Commit any part that is complete but not yet durable — in parallel, since
  //    parts live on different bots with independent rate limits.
  const pending = sql("SELECT idx FROM upload_parts WHERE upload_id = ? AND ref IS NULL ORDER BY idx").pluck().all(id) as number[];
  const commits = await Promise.allSettled(pending.map((idx) => commitPart(rt, l, idx)));
  const failed = commits.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed) {
    missing = missingRanges(id);
    if (missing.length) return reopen({ missing, reason: "incomplete" });
    setState(id, "active");
    throw failed.reason;
  }

  // 4. Publish: blob + parts (with stored piece hashes) + node, atomically.
  const result = tx(() => {
    if (readState(id) !== "completing") throw conflict("Upload state changed during completion");
    const parts = sql("SELECT idx, size, ref FROM upload_parts WHERE upload_id = ? ORDER BY idx").all(id) as { idx: number; size: number; ref: string | null }[];
    if (parts.some((p) => !p.ref)) throw new HttpError(500, "A part lost its storage reference during completion");
    // The same bytes may have landed meanwhile (the same file uploaded twice at
    // once): link to that copy and let ours go, so storage keeps exactly one.
    const twin = verified
      ? (sql("SELECT id FROM blobs WHERE sha256 = ? AND size = ? AND corrupt_at IS NULL ORDER BY verified_at IS NULL, created_at LIMIT 1")
          .pluck()
          .get(sha256, l.meta.size) as string | undefined)
      : undefined;
    let stored = false;
    const placed = placeUpload({
      parentId: l.meta.parentId,
      name: l.meta.name,
      size: l.meta.size,
      mime: l.meta.mime,
      blobId: twin ?? l.meta.blobId,
      sha256: verified ? sha256 : null,
      policy: l.meta.policy ?? "keep",
      takenAt: l.meta.takenAt ?? null,
      onCreate: () => {
        if (twin) return;
        sql(
          "INSERT INTO blobs (id, size, sha256, part_size, part_count, driver, enc_iv, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(l.meta.blobId, l.meta.size, verified ? sha256 : null, l.meta.partSize, parts.length, rt.driver.name, l.encIv, now());
        const insertPart = sql("INSERT INTO blob_parts (blob_id, idx, size, ref, piece_hashes) VALUES (?, ?, ?, ?, ?)");
        const zero = Buffer.alloc(32);
        for (const p of parts) {
          const hashes = pieceHashes(id, p.idx, p.size, "stored");
          for (let o = 0; o < hashes.length; o += 32) {
            if (hashes.subarray(o, o + 32).equals(zero)) throw new HttpError(500, `Part ${p.idx} is missing piece checksums`);
          }
          insertPart.run(l.meta.blobId, p.idx, p.size, p.ref, hashes);
        }
        stored = true;
      },
    });
    if (!stored) {
      // Our bytes aren't needed: an identical file or blob already exists.
      const enqueue = sql("INSERT INTO gc_queue (driver, blob_id, ref, next_at) VALUES (?, ?, ?, ?)");
      for (const p of parts) enqueue.run(l.meta.driver, l.meta.blobId, p.ref, now());
      if (twin) metrics.inc("uploads.dedupedAtCompletion");
    }
    const r: UploadResult = { node: placed.node, outcome: placed.outcome };
    setState(id, "completed", r);
    sql("DELETE FROM upload_pieces WHERE upload_id = ?").run(id);
    recordLanding(r, l.meta.size, l.meta.via ? { shareId: l.meta.via, from: l.meta.from ?? null } : undefined);
    return { ...r, replaced: placed.replaced };
  });
  live.delete(id);
  metrics.gauges.activeUploads = activeCount();
  metrics.inc("uploads.completed");
  announceLanding(result);
  return { node: result.node, outcome: result.outcome };
}

// ---------------------------------------------------------------------------
// dedup / abort / sweep
// ---------------------------------------------------------------------------

function collectRefs(id: string): string[] {
  return sql("SELECT ref FROM upload_parts WHERE upload_id = ? AND ref IS NOT NULL").pluck().all(id) as string[];
}

function abandonDriverParts(rt: Runtime, id: string) {
  const states = sql("SELECT driver_state FROM upload_parts WHERE upload_id = ? AND ref IS NULL AND driver_state IS NOT NULL").pluck().all(id) as string[];
  for (const s of states) void rt.driver.abortPart(JSON.parse(s)).catch(() => {});
}

/**
 * Content-addressed dedup for an in-progress upload: if a verified blob with
 * the same SHA-256 and size already exists, the session is atomically switched
 * to `deduped` and a node pointing at the existing blob is created — exactly
 * once, and never in addition to a normal completion.
 */
export function dedupeUpload(rt: Runtime, id: string, body: { sha256?: unknown }): { node: DriveNode | null; state: UploadState; outcome?: UploadOutcome } {
  const l = load(id);
  if (typeof body.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(body.sha256)) throw badRequest("Invalid sha256");
  if (l.completing) return { node: null, state: "completing" };
  const sha = body.sha256;
  const outcome = tx(() => {
    const state = readState(id)!;
    const none = { node: null, state, refs: [] as string[], fresh: false, outcome: undefined as UploadOutcome | undefined, replaced: undefined as string | undefined };
    if (state === "deduped") {
      const stored = storedResult(id);
      return { ...none, node: stored.node, outcome: stored.outcome };
    }
    if (state !== "active") return none;
    const blob = sql(
      "SELECT id FROM blobs WHERE sha256 = ? AND size = ? AND corrupt_at IS NULL ORDER BY verified_at IS NULL, created_at LIMIT 1",
    ).get(sha, l.meta.size) as { id: string } | undefined;
    if (!blob) return none;
    const placed = placeUpload({
      parentId: l.meta.parentId,
      name: l.meta.name,
      size: l.meta.size,
      mime: l.meta.mime,
      blobId: blob.id,
      sha256: sha,
      policy: l.meta.policy ?? "keep",
      takenAt: l.meta.takenAt ?? null,
    });
    const refs = collectRefs(id);
    const enqueue = sql("INSERT INTO gc_queue (driver, blob_id, ref, next_at) VALUES (?, ?, ?, ?)");
    for (const r of refs) enqueue.run(l.meta.driver, l.meta.blobId, r, now());
    const r: UploadResult = { node: placed.node, outcome: placed.outcome };
    setState(id, "deduped", r);
    sql("DELETE FROM upload_pieces WHERE upload_id = ?").run(id);
    recordLanding(r, l.meta.size, l.meta.via ? { shareId: l.meta.via, from: l.meta.from ?? null } : undefined);
    return { node: placed.node, state: "deduped" as UploadState, refs, fresh: true, outcome: placed.outcome, replaced: placed.replaced };
  });
  if (outcome.fresh && outcome.node) {
    abandonDriverParts(rt, id);
    live.delete(id);
    metrics.gauges.activeUploads = activeCount();
    metrics.inc("uploads.deduped");
    metrics.inc("uploads.bytesDeduped", l.meta.size);
    announceLanding({ node: outcome.node, outcome: outcome.outcome!, replaced: outcome.replaced });
  }
  return { node: outcome.node, state: outcome.state, outcome: outcome.outcome };
}

/** Cancels an upload. Idempotent; a finished upload stays finished. */
export async function abortUpload(rt: Runtime, id: string): Promise<{ state: UploadState }> {
  let l: Live;
  try {
    l = load(id);
  } catch {
    return { state: "aborted" };
  }
  if (l.completing) await l.completing.catch(() => {});
  const state = tx(() => {
    const st = readState(id);
    if (st !== "active" && st !== "completing") return st ?? "aborted";
    const enqueue = sql("INSERT INTO gc_queue (driver, blob_id, ref, next_at) VALUES (?, ?, ?, ?)");
    for (const r of collectRefs(id)) enqueue.run(l.meta.driver, l.meta.blobId, r, now());
    setState(id, "aborted");
    sql("DELETE FROM upload_pieces WHERE upload_id = ?").run(id);
    return "aborted" as UploadState;
  });
  if (state === "aborted") {
    abandonDriverParts(rt, id);
    live.delete(id);
    metrics.gauges.activeUploads = activeCount();
  }
  return { state };
}

/** After a crash, sessions stuck in `completing` become resumable again. */
export function recoverUploads() {
  const n = sql("UPDATE upload_sessions SET state = 'active', updated_at = ? WHERE state = 'completing'").run(now()).changes;
  if (n) log.warn("upload", `${n} upload(s) were interrupted mid-completion — reopened for retry`);
}

/**
 * Cancels uploads nobody resumed within UPLOAD_RESUME_DAYS (their finished
 * parts are then deleted from the channel); forgets finished sessions after a day.
 */
export async function sweepStaleUploads(rt: Runtime) {
  const day = 24 * 60 * 60 * 1000;
  const stale = sql("SELECT id FROM upload_sessions WHERE state IN ('active', 'completing') AND updated_at < ?")
    .pluck()
    .all(now() - config().uploads.resumeDays * day) as string[];
  for (const id of stale) await abortUpload(rt, id);
  const done = sql("DELETE FROM upload_sessions WHERE state IN ('completed', 'deduped', 'aborted') AND updated_at < ?").run(now() - day).changes;
  if (stale.length || done) log.info("upload", `swept ${stale.length} stale and ${done} finished upload session(s)`);
}
