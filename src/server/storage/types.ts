import "server-only";
import type { BotStatus } from "@/lib/types";
import type { PriorityToken } from "../lb";

export type DriverName = "telegram" | "local" | "sim";

/** Driver-specific, JSON-serialisable state for an in-progress part upload. */
export type PartUploadState = Record<string, string | number | boolean>;

export interface PartInfo {
  blobId: string;
  index: number;
  size: number;
  /** Name shown on the underlying storage (e.g. the Telegram document name). */
  fileName: string;
  /** Free-form caption stored next to the part, used for disaster recovery. */
  caption: string;
}

/** Scheduling context for one I/O: its (raisable) priority. */
export interface IoContext {
  token: PriorityToken;
}

// ---------------------------------------------------------------------------
// Error vocabulary shared by every layer. Transports translate their native
// errors into these; the pool, the HTTP layer and the client all understand them.
// ---------------------------------------------------------------------------

/** The backend asked us to slow down for `seconds`. */
export class FloodWaitError extends Error {
  constructor(
    readonly seconds: number,
    message = `Rate limited for ${seconds}s`,
  ) {
    super(message);
  }
}

/** Worth retrying (timeouts, dropped connections, 5xx). */
export class TransientError extends Error {}

/** The referenced data no longer exists in storage. */
export class GoneError extends Error {}

/** Temporarily unable to serve; surfaces as HTTP 503 with Retry-After. */
export class UnavailableError extends Error {
  constructor(
    message: string,
    readonly retryAfterSec: number,
  ) {
    super(message);
  }
}

/**
 * The index is being restored from Telegram (a fresh disk) — 503 with
 * `restoring: true`, so the app can show what's going on instead of an error.
 */
export class RestoringError extends UnavailableError {
  readonly restoring = true;
  constructor(message: string, retryAfterSec = 3) {
    super(message, retryAfterSec);
  }
}

/** Bytes failed checksum verification even after refetching. */
export class IntegrityError extends Error {}

/** One post in the storage channel, as far as recovery and backups care. */
export interface ChannelPost {
  /** Message id (Telegram) or its equivalent. */
  id: number;
  /** The driver's reference for reading or deleting it, as stored in blob_parts.ref. */
  ref: string;
  caption: string;
  size: number;
  fileName: string | null;
}

export interface StorageDriver {
  readonly name: DriverName;
  /** True if fetched blocks should go through the memory/disk block cache. */
  readonly cacheable: boolean;
  init(): Promise<void>;
  stop(): Promise<void>;
  beginPart(info: PartInfo): Promise<PartUploadState>;
  /** Writes one 512 KiB piece. Must be idempotent — pieces may be retried. */
  writePiece(state: PartUploadState, pieceIndex: number, totalPieces: number, data: Buffer, ctx?: IoContext): Promise<void>;
  /** Makes the part durable and returns an opaque reference stored in `blob_parts.ref`. */
  commitPart(state: PartUploadState, info: PartInfo, totalPieces: number): Promise<string>;
  abortPart(state: PartUploadState): Promise<void>;
  /** Reads a byte range of a committed part. `offset` is 1 MiB aligned, `length` ≤ 1 MiB. */
  readBlock(ref: string, offset: number, length: number, ctx?: IoContext): Promise<Buffer>;
  deleteParts(refs: string[]): Promise<void>;
  /** Pins a stored part so it can be found without the index (metadata backups). */
  pin?(ref: string): Promise<void>;
  /** The most recently pinned post (the current backup, normally). */
  pinnedPost?(): Promise<ChannelPost | null>;
  /** Rewrites a post's caption (marks a backup as handed over). */
  editCaption?(ref: string, caption: string): Promise<void>;
  /** Session of the first bot, for the next server to start from without a fresh login (Telegram only). */
  firstSession?(): { token: string; session: string } | null;
  status(): DriverStatus;
}

export interface DriverStatus {
  bots: BotStatus[];
  channel: { id: string; title: string | null } | null;
}
