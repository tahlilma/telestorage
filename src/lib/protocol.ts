/**
 * Upload protocol constants and geometry shared by the browser engine and the
 * server, so both sides always agree on where pieces and windows fall.
 *
 *   file ─┬─ part 0 (partSize, one Telegram document) ─┬─ window 0 (16 pieces = 8 MiB) ─ piece 0..15 (512 KiB)
 *         │                                              └─ window 1 …
 *         └─ part 1 …
 *
 * Pieces are the unit of storage writes and checksums; windows are the unit of
 * resend/verification bookkeeping; chunks (HTTP requests) are any piece-aligned
 * range inside one part.
 */
export const PIECE_SIZE = 512 * 1024;
export const WINDOW_PIECES = 16;
export const WINDOW_SIZE = PIECE_SIZE * WINDOW_PIECES;
export const DEFAULT_CHUNK_SIZE = WINDOW_SIZE;
/** Hard ceiling for one request body (Cloudflare's free plan caps bodies at 100 MB). */
export const MAX_CHUNK_SIZE = 32 * 1024 * 1024;

export const piecesIn = (bytes: number) => Math.max(1, Math.ceil(bytes / PIECE_SIZE));

/**
 * Largest file the protocol accepts: byte offsets are JavaScript numbers, exact
 * up to 2^53 − 1 bytes (8 PiB). Telegram's own limit applies per part, not per
 * file, so this is the only per-file ceiling.
 */
export const MAX_FILE_SIZE = Number.MAX_SAFE_INTEGER;

/**
 * Proof of reassembly is a three-level hash tree, so it stays small whatever
 * the file size:
 *
 *   piece hash  = SHA-256(512 KiB piece)
 *   window hash = SHA-256(piece hashes of the window's ≤ 16 pieces)
 *   part root   = SHA-256(window hashes of the part)
 *
 * The browser sends one 32-byte root per part. Completing a 1 TiB file with
 * 512 MiB parts sends 2 048 roots instead of 131 072 window hashes, and the
 * server checks one part at a time with at most 128 KiB of hashes in memory.
 * Returns the piece count of each window of a part.
 */
export function windowsOfPart(partBytes: number): number[] {
  const out: number[] = [];
  for (let left = piecesIn(partBytes); left > 0; left -= WINDOW_PIECES) out.push(Math.min(WINDOW_PIECES, left));
  return out;
}

/** Sizes of each part of a file. */
export function partSizes(size: number, partSize: number): number[] {
  const out: number[] = [];
  for (let off = 0; off < size; off += partSize) out.push(Math.min(partSize, size - off));
  return out;
}

export interface WindowSlot {
  part: number;
  window: number;
  /** First piece index within the part. */
  firstPiece: number;
  pieces: number;
}

/** Every verification window of a file, in canonical (part, window) order. */
export function windowLayout(size: number, partSize: number): WindowSlot[] {
  const out: WindowSlot[] = [];
  partSizes(size, partSize).forEach((bytes, part) => {
    const n = piecesIn(bytes);
    for (let w = 0, first = 0; first < n; w++, first += WINDOW_PIECES) {
      out.push({ part, window: w, firstPiece: first, pieces: Math.min(WINDOW_PIECES, n - first) });
    }
  });
  return out;
}

export type UploadState = "active" | "completing" | "completed" | "deduped" | "aborted";

export interface MissingRange {
  part: number;
  offset: number;
  length: number;
}

/** Response of POST /api/uploads/:id/complete when bytes still need (re)sending. */
export interface CompleteRetry {
  missing: MissingRange[];
  reason: "incomplete" | "checksum";
}
