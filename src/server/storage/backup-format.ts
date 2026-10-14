import "server-only";
import { deriveKey, openGcm, sealGcm } from "./crypto";

/**
 * Formats of what the index leaves in the Telegram channel: backup posts and
 * their captions, thumbnail packs, and the bot session that rides along so
 * the next server can start without logging the bot in again. No I/O here.
 */

export const BACKUP_TAG = "#telestorage_backup";
export const THUMBS_TAG = "#telestorage_thumbs";
/** Telegram's caption limit for bots is 1024 characters. */
const CAPTION_MAX = 1000;

export interface BackupCaption {
  /** Format version: 3 adds everything below `at`; 1–2 carried only the time. */
  v: number;
  at: number;
  /** Which drive the backup belongs to (kv drive.id). */
  drive: string | null;
  /**
   * Branch: one per line of history. A server that restores a backup starts a
   * new branch from it, so two servers restored from the same backup can be
   * told apart.
   */
  br: string | null;
  /** Message id of the backup this one continues from. */
  par: number | null;
  /** The index's change counter when the backup was taken. */
  rev: number | null;
  /** Made by a server that was shutting down: it won't change the drive any more. */
  rel: boolean;
  /** The payload is sealed with ENCRYPTION_KEY. */
  enc: boolean;
  /** The first bot's session, sealed with a key derived from its token. */
  s0: string | null;
}

export function backupCaption(c: Omit<BackupCaption, "v">): string {
  const body: Record<string, unknown> = { v: 3, at: c.at, drive: c.drive, br: c.br, par: c.par, rev: c.rev, rel: c.rel ? 1 : 0, enc: c.enc ? 1 : 0 };
  if (c.s0) body.s0 = c.s0;
  let text = `${BACKUP_TAG} ${JSON.stringify(body)}`;
  if (text.length > CAPTION_MAX) {
    delete body.s0;
    text = `${BACKUP_TAG} ${JSON.stringify(body)}`;
  }
  return text;
}

export function parseBackupCaption(caption: string | null | undefined): BackupCaption | null {
  if (!caption || !caption.startsWith(BACKUP_TAG)) return null;
  let j: Record<string, unknown> = {};
  try {
    const rest = caption.slice(BACKUP_TAG.length).trim();
    j = rest ? (JSON.parse(rest) as Record<string, unknown>) : {};
  } catch {
    j = {};
  }
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const str = (x: unknown) => (typeof x === "string" && x ? x : null);
  return {
    v: num(j.v) ?? 1,
    at: num(j.at) ?? 0,
    drive: str(j.drive),
    br: str(j.br),
    par: num(j.par),
    rev: num(j.rev),
    rel: j.rel === 1 || j.rel === true,
    enc: j.enc === 1 || j.enc === true,
    s0: str(j.s0),
  };
}

/** Same caption with the hand-over flag set (edited in place when a server stops). */
export function releasedCaption(caption: string): string | null {
  const c = parseBackupCaption(caption);
  if (!c || c.v < 3) return null;
  return backupCaption({ ...c, rel: true });
}

// ---------------------------------------------------------------------------
// Bot sessions. A GramJS StringSession is "1" + base64(DC, address, auth key).
// Sealed with a key derived from the bot's own token, it is worthless to
// anyone without that token — and whoever has the token can log in anyway.
// ---------------------------------------------------------------------------

export function sealSession(token: string, session: string): string {
  const binary = session.startsWith("1");
  const raw = binary ? Buffer.from(session.slice(1), "base64") : Buffer.from(session, "utf8");
  const sealed = sealGcm(deriveKey(token, "bot-session/v1"), Buffer.concat([Buffer.from([binary ? 1 : 0]), raw]));
  return sealed.subarray(4).toString("base64url");
}

export function openSession(token: string, sealed: string): string | null {
  try {
    const buf = openGcm(deriveKey(token, "bot-session/v1"), Buffer.concat([Buffer.from("TSB1"), Buffer.from(sealed, "base64url")]));
    const raw = buf.subarray(1);
    return buf[0] === 1 ? `1${raw.toString("base64")}` : raw.toString("utf8");
  } catch {
    return null; // another token (or a changed one): log in afresh
  }
}

export const botId = (token: string) => token.split(":")[0];

// ---------------------------------------------------------------------------
// Thumbnail packs: many small images in one post, so each thumbnail is
// uploaded once instead of riding along in every index backup.
// ---------------------------------------------------------------------------

export interface PackedThumb {
  blobId: string;
  mime: string;
  width: number | null;
  height: number | null;
  data: Buffer;
}

const PACK_MAGIC = "TSTP1";

export function encodeThumbPack(items: PackedThumb[]): Buffer {
  const header = Buffer.from(JSON.stringify(items.map((t) => ({ b: t.blobId, m: t.mime, w: t.width, h: t.height, l: t.data.length }))));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(header.length);
  return Buffer.concat([Buffer.from(PACK_MAGIC, "latin1"), len, header, ...items.map((t) => t.data)]);
}

export function decodeThumbPack(buf: Buffer): PackedThumb[] {
  if (buf.subarray(0, PACK_MAGIC.length).toString("latin1") !== PACK_MAGIC) throw new Error("Not a thumbnail pack");
  const headerLen = buf.readUInt32BE(PACK_MAGIC.length);
  let off = PACK_MAGIC.length + 4;
  const header = JSON.parse(buf.subarray(off, off + headerLen).toString("utf8")) as { b: string; m: string; w: number | null; h: number | null; l: number }[];
  off += headerLen;
  return header.map((h) => {
    const data = buf.subarray(off, off + h.l);
    if (data.length !== h.l) throw new Error("Thumbnail pack is truncated");
    off += h.l;
    return { blobId: h.b, mime: h.m, width: h.w, height: h.h, data };
  });
}

// ---------------------------------------------------------------------------
// Whose backup is pinned? Decides whether this server may take over the pin.
// ---------------------------------------------------------------------------

/** The backup this index corresponds to: the one it was restored from, or its own latest. */
export interface BackupBase {
  /** Message id of that backup post. */
  m: number;
  br: string | null;
  rev: number | null;
}

export type PinnedVerdict =
  /** Nothing of this drive is pinned (or only a pre-v3 backup): go ahead. */
  | { kind: "free" }
  /** This branch's own backup, or the one this index continues from. */
  | { kind: "ours" }
  /** Another server built on exactly this index's latest backup. */
  | { kind: "ahead" }
  /** Another server of this drive went its own way from an older point. */
  | { kind: "diverged" }
  /** Another drive's backup: the channel is shared by mistake. */
  | { kind: "foreign" };

export function judgePinned(
  pinned: { m: number; caption: BackupCaption | null } | null,
  me: { drive: string; branch: string; base: BackupBase | null },
): PinnedVerdict {
  const c = pinned?.caption;
  if (!pinned || !c) return { kind: "free" };
  if (!c.drive) return { kind: "free" }; // written before drives had ids: the server that upgraded is its continuation
  if (c.drive !== me.drive) return { kind: "foreign" };
  if (c.br === me.branch) return { kind: "ours" };
  if (me.base && pinned.m === me.base.m) return { kind: "ours" };
  if (me.base && c.par === me.base.m) return { kind: "ahead" };
  return { kind: "diverged" };
}
