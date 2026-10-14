import "server-only";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import Database from "better-sqlite3";
import { BLOCK_SIZE, PIECE_SIZE, config } from "../config";
import { databaseOpen, db, kv, replaceDatabase, sql, tx } from "../db";
import { events } from "../events";
import { log, metrics } from "../metrics";
import { forgetAllBlobMeta, type Runtime } from "./blobs";
import {
  THUMBS_TAG,
  backupCaption,
  botId,
  decodeThumbPack,
  encodeThumbPack,
  judgePinned,
  parseBackupCaption,
  sealSession,
  type BackupBase,
  type BackupCaption,
  type PackedThumb,
} from "./backup-format";
import { isSealed, openGcm, sealGcm } from "./crypto";
import { materializeBackup } from "./recovery";
import type { ChannelPost, PartInfo } from "./types";

/**
 * Index backups. Files already live in Telegram; the index (names, folders,
 * which posts hold which file) is the one thing that doesn't, so it follows
 * every change there within about half a minute, pinned in the channel where
 * a server starting on an empty disk finds it (recovery.ts).
 *
 * Safety rules, because a server on a wiped disk is the one that must never
 * write over the real backup:
 *  - a backup is only pinned over the drive's own latest backup, never over a
 *    different drive's, and never over a newer line of history unless this
 *    server holds changes of its own that would otherwise be lost;
 *  - only backups this server's own line of history made are ever deleted;
 *  - thumbnails go in packs of their own, each uploaded once, so frequent
 *    backups stay small (and cheap on hosts that meter bandwidth).
 */

const MiB = 1024 * 1024;
/** Thumbnail packs stay small so the first thumbnail after a restore appears quickly. */
const PACK_TARGET = 4 * MiB;
/** Backups kept per line of history. */
const KEEP = 3;

export type BackupResult = { status: "stored" | "released" | "clean" | "off" | "conflict" | "failed"; message?: string };

interface HistoryEntry {
  at: number;
  size: number;
  ref?: string;
  /** v1 entries stored the bare message id. */
  msgId?: number;
  file?: string;
}

export interface BackupNotice {
  kind: "diverged" | "foreign" | "unpinned";
  message: string;
  at: number;
}

const g = globalThis as unknown as { __tsBackup?: { queue: Promise<unknown>; released: boolean; running: boolean } };
const st = (g.__tsBackup ??= { queue: Promise.resolve(), released: false, running: false });

/** One backup operation at a time, in order (scheduled, "Back up now", hand-over, adopting). */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = st.queue.then(async () => {
    st.running = true;
    try {
      return await fn();
    } finally {
      st.running = false;
    }
  });
  st.queue = next.catch(() => {});
  return next;
}

export function currentRev(): number {
  return (sql("SELECT rev FROM drive_rev WHERE id = 1").pluck().get() as number | undefined) ?? 0;
}

const backedUpRev = () => Number(kv.get("backup.rev") ?? "-1");

/** Changes exist that no backup has yet. */
export function isDirty(): boolean {
  return currentRev() !== backedUpRev();
}

const driveId = () => kv.get("drive.id") ?? "unknown";

function branch(): string {
  let b = kv.get("drive.branch");
  if (!b) {
    b = crypto.randomBytes(6).toString("base64url");
    kv.set("drive.branch", b);
  }
  return b;
}

function base(): BackupBase | null {
  const raw = kv.get("backup.base");
  return raw ? (JSON.parse(raw) as BackupBase) : null;
}

function setNotice(n: Omit<BackupNotice, "at"> | null) {
  if (n) kv.set("backup.notice", JSON.stringify({ ...n, at: Date.now() }));
  else kv.delete("backup.notice");
}

/** Someone is using the drive right now (a download, an upload, a click in the last 20 s). */
function busy() {
  return metrics.gauges.activeStreams > 0 || Date.now() - metrics.lastForegroundAt < 20_000;
}

const msgIdOf = (ref: string) => (JSON.parse(ref) as { m?: number }).m ?? null;

/** Uploads a standalone buffer through the regular driver pipeline (one part). */
export async function storeBuffer(rt: Runtime, data: Buffer, fileName: string, caption: string, blobId = "backup"): Promise<string> {
  const info: PartInfo = { blobId, index: 0, size: data.length, fileName, caption };
  const state = await rt.driver.beginPart(info);
  const total = Math.ceil(data.length / PIECE_SIZE);
  for (let i = 0; i < total; i++) await rt.driver.writePiece(state, i, total, data.subarray(i * PIECE_SIZE, (i + 1) * PIECE_SIZE));
  return rt.driver.commitPart(state, info, total);
}

/** Reads a whole stored post (a backup or a thumbnail pack), a few blocks at a time. */
export async function readPost(rt: Runtime, ref: string, size: number): Promise<Buffer> {
  const blocks = Math.ceil(size / BLOCK_SIZE);
  const out: Buffer[] = new Array(blocks);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < blocks; i = next++) out[i] = await rt.driver.readBlock(ref, i * BLOCK_SIZE, Math.min(BLOCK_SIZE, size - i * BLOCK_SIZE));
  };
  await Promise.all(Array.from({ length: Math.min(4, blocks) }, worker));
  return Buffer.concat(out);
}

// ---------------------------------------------------------------------------
// Thumbnail packs
// ---------------------------------------------------------------------------

async function packThumbs(rt: Runtime) {
  const key = config().encryptionKey;
  for (;;) {
    const candidates = sql("SELECT blob_id AS blobId, mime, data, width, height FROM thumbs WHERE pack IS NULL AND length(data) > 0 LIMIT 500").all() as PackedThumb[];
    if (!candidates.length) return;
    const items: PackedThumb[] = [];
    let bytes = 0;
    for (const t of candidates) {
      if (items.length && bytes + t.data.length > PACK_TARGET) break;
      items.push(t);
      bytes += t.data.length;
    }
    let payload = encodeThumbPack(items);
    if (key) payload = sealGcm(key, payload);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const ref = await storeBuffer(
      rt,
      payload,
      `telestorage-thumbs-${stamp}.pack${key ? ".enc" : ""}`,
      `${THUMBS_TAG} ${JSON.stringify({ v: 1, drive: driveId(), n: items.length })}`,
      "thumbs",
    );
    tx(() => {
      const id = Number(sql("INSERT INTO thumb_packs (ref, size, count, created_at) VALUES (?, ?, ?, ?)").run(ref, payload.length, items.length, Date.now()).lastInsertRowid);
      // Only rows still holding exactly what was packed (a thumbnail replaced meanwhile goes in the next pack).
      const mark = sql("UPDATE thumbs SET pack = ? WHERE blob_id = ? AND pack IS NULL AND data = ?");
      for (const t of items) mark.run(id, t.blobId, t.data);
    });
    metrics.inc("backup.thumbPacks");
  }
}

/** Packs none of whose thumbnails exist any more leave the channel. */
function dropDeadPacks(rt: Runtime) {
  const dead = sql("SELECT id, ref FROM thumb_packs p WHERE NOT EXISTS (SELECT 1 FROM thumbs t WHERE t.pack = p.id)").all() as { id: number; ref: string }[];
  if (!dead.length) return;
  tx(() => {
    const enqueue = sql("INSERT INTO gc_queue (driver, blob_id, ref, next_at) VALUES (?, 'thumbs', ?, ?)");
    const drop = sql("DELETE FROM thumb_packs WHERE id = ?");
    for (const p of dead) {
      enqueue.run(rt.driver.name, p.ref, Date.now());
      drop.run(p.id);
    }
  });
}

const packLoads = new Map<number, Promise<void>>();

/** Brings a pack's thumbnails back after a restore (the index carries only which pack holds them). */
export function loadThumbPack(rt: Runtime, packId: number): Promise<void> {
  const existing = packLoads.get(packId);
  if (existing) return existing;
  const p = (async () => {
    const row = sql("SELECT ref, size FROM thumb_packs WHERE id = ?").get(packId) as { ref: string; size: number } | undefined;
    if (!row) return;
    let buf = await readPost(rt, row.ref, row.size);
    if (isSealed(buf)) {
      const key = config().encryptionKey;
      if (!key) throw new Error("Thumbnails are encrypted but ENCRYPTION_KEY is not set");
      buf = openGcm(key, buf);
    }
    const items = decodeThumbPack(buf);
    tx(() => {
      const fill = sql("UPDATE thumbs SET data = ? WHERE blob_id = ? AND pack = ? AND length(data) = 0");
      for (const t of items) fill.run(t.data, t.blobId, packId);
    });
    metrics.inc("backup.thumbPacksLoaded");
  })().finally(() => packLoads.delete(packId));
  packLoads.set(packId, p);
  return p;
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/**
 * A copy of the index fit to leave the box: no replay cache, bot sessions
 * sealed with their own tokens (so the next server needn't log the bots in
 * again), and — for Telegram — thumbnails left to their packs.
 */
async function snapshot(stripThumbs: boolean): Promise<{ payload: Buffer; rev: number }> {
  const cfg = config();
  const tmp = path.join(cfg.dataDir, `backup-${Date.now()}-${crypto.randomBytes(3).toString("hex")}.db`);
  // Read before copying: changes made during the copy count as not backed up yet.
  const rev = currentRev();
  try {
    await db().backup(tmp);
    const copy = new Database(tmp);
    try {
      copy.transaction(() => {
        copy.prepare("DELETE FROM idempotency").run();
        const put = copy.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v");
        const read = copy.prepare("SELECT v FROM kv WHERE k = ?").pluck();
        for (const token of cfg.tg.botTokens) {
          const session = read.get(`tg.session.${botId(token)}`) as string | undefined;
          if (session) put.run(`tg.vault.${botId(token)}`, sealSession(token, session));
        }
        copy.prepare("DELETE FROM kv WHERE k LIKE 'tg.session.%' OR k IN ('backup.error', 'backup.notice')").run();
        if (stripThumbs) copy.prepare("UPDATE thumbs SET data = x'' WHERE pack IS NOT NULL").run();
      })();
      copy.exec("VACUUM");
    } finally {
      copy.close();
    }
    let payload: Buffer = zlib.gzipSync(await fs.promises.readFile(tmp), { level: 6 });
    if (cfg.encryptionKey) payload = sealGcm(cfg.encryptionKey, payload);
    return { payload, rev };
  } finally {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
  }
}

function recordBackup(entry: HistoryEntry, rev: number, nextBase: BackupBase | null) {
  kv.set("backup.rev", String(rev));
  if (nextBase) kv.set("backup.base", JSON.stringify(nextBase));
  kv.set("backup.last", JSON.stringify(entry));
  kv.delete("backup.error");
}

async function pruneHistory(rt: Runtime, entry: HistoryEntry, keepRefs: Set<string>) {
  const cfg = config();
  const history = JSON.parse(kv.get("backup.history") ?? "[]") as HistoryEntry[];
  history.push(entry);
  const old = history.splice(0, Math.max(0, history.length - KEEP));
  kv.set("backup.history", JSON.stringify(history));
  for (const h of old) {
    const ref = h.ref ?? (h.msgId ? JSON.stringify({ m: h.msgId }) : null);
    if (ref && rt.driver.name !== "local" && !keepRefs.has(ref)) await rt.driver.deleteParts([ref]).catch(() => {});
    if (h.file) await fs.promises.rm(path.join(cfg.dataDir, "backups", h.file), { force: true });
  }
}

async function localBackup(rt: Runtime): Promise<BackupResult> {
  const cfg = config();
  const { payload, rev } = await snapshot(false);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `telestorage-backup-${stamp}.db.gz${cfg.encryptionKey ? ".enc" : ""}`;
  const dir = path.join(cfg.dataDir, "backups");
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, name), payload);
  const entry: HistoryEntry = { at: Date.now(), size: payload.length, file: name };
  recordBackup(entry, rev, null);
  await pruneHistory(rt, entry, new Set());
  return { status: "stored" };
}

// ---------------------------------------------------------------------------
// Backing up
// ---------------------------------------------------------------------------

export function runBackup(rt: Runtime, opts: { force?: boolean; release?: boolean } = {}): Promise<BackupResult> {
  return serial(() => backupNow(rt, opts));
}

async function backupNow(rt: Runtime, opts: { force?: boolean; release?: boolean }): Promise<BackupResult> {
  const cfg = config();
  if (!cfg.durability.backups && !opts.force) return { status: "off" };
  const dirty = isDirty();
  if (!dirty && !opts.force && !opts.release) return { status: "clean" };
  try {
    if (rt.driver.name === "local" || !rt.driver.pinnedPost) {
      if (!dirty && !opts.force) return { status: "clean" };
      const r = await localBackup(rt);
      events.emit({ type: "backup" });
      return r;
    }

    // 1. Whose backup is pinned right now?
    const pinned = await rt.driver.pinnedPost();
    const pinnedCaption = parseBackupCaption(pinned?.caption);
    const me = { drive: driveId(), branch: branch(), base: base() };
    let verdict = judgePinned(pinned && { m: pinned.id, caption: pinnedCaption }, me).kind;
    const allowed = kv.get("backup.allowReplace");
    if (verdict !== "free" && verdict !== "ours" && allowed && (allowed === "any" || allowed === pinnedCaption?.drive)) verdict = "free";

    if (!dirty && !opts.force) {
      // A hand-over with nothing new: mark the pinned backup as handed over, in place.
      if (opts.release && verdict === "ours" && pinned && pinnedCaption && pinnedCaption.v >= 3) {
        if (!pinnedCaption.rel) await rt.driver.editCaption?.(pinned.ref, backupCaption({ ...pinnedCaption, rel: true }));
        st.released = true;
        log.info("backup", "handed the drive over (latest backup marked as final)");
        return { status: "released" };
      }
      if (verdict === "ours" || verdict === "free") {
        if (!opts.release) return { status: "clean" };
        // Pre-v3 (or no) pinned backup: write a proper final one below.
      } else {
        return { status: "clean" }; // another server owns the pin and nothing here is unsaved
      }
    }

    // 2. Another server's line moved on. With nothing of our own unsaved, the
    //    follower adopts it; with changes here, they win (this server is the
    //    one in use) and the other line's backup stays in the channel.
    const takeOver = verdict === "ahead" || verdict === "diverged";
    const pin = verdict !== "foreign";

    // 3. Thumbnails first: the snapshot then only says which pack holds each.
    await packThumbs(rt);
    const { payload, rev } = await snapshot(true);

    // 4. Post it.
    const firstSession = rt.driver.firstSession?.() ?? null;
    const caption: Omit<BackupCaption, "v"> = {
      at: Date.now(),
      drive: me.drive,
      br: me.branch,
      par: me.base?.m ?? (pinned && pinnedCaption && verdict !== "foreign" ? pinned.id : null),
      rev,
      rel: Boolean(opts.release),
      enc: Boolean(cfg.encryptionKey),
      s0: firstSession ? sealSession(firstSession.token, firstSession.session) : null,
    };
    const stamp = new Date(caption.at).toISOString().replace(/[:.]/g, "-");
    const name = `telestorage-backup-${stamp}.db.gz${cfg.encryptionKey ? ".enc" : ""}`;
    const ref = await storeBuffer(rt, payload, name, backupCaption(caption));
    const msgId = msgIdOf(ref);

    let pinError: string | null = null;
    if (pin) {
      try {
        await rt.driver.pin?.(ref);
      } catch (e) {
        pinError = (e as Error).message;
      }
    }

    // 5. Bookkeeping, then retire this line's older backups (never another line's).
    const entry: HistoryEntry = { at: caption.at, size: payload.length, ref };
    recordBackup(entry, rev, pin && msgId !== null ? { m: msgId, br: me.branch, rev } : null);
    const keep = new Set<string>([ref, ...(pinned ? [pinned.ref] : [])]);
    await pruneHistory(rt, entry, keep);
    if (pin) kv.delete("backup.allowReplace");
    dropDeadPacks(rt);

    if (verdict === "foreign") {
      setNotice({
        kind: "foreign",
        message: "The backup pinned in the channel belongs to a different Telestorage drive. This drive's backups are stored but not pinned, so a server starting on an empty disk would restore the other drive. Use a separate channel for each drive.",
      });
    } else if (pinError) {
      setNotice({ kind: "unpinned", message: `Backups can't be pinned (${pinError}). Give the bots the "Pin messages" right — a server starting on an empty disk restores the pinned backup.` });
    } else if (takeOver && pinnedCaption) {
      setNotice({
        kind: "diverged",
        message: `Another server changed this drive at the same time. This server's version is now the one a restart restores; the other server's latest backup (${new Date(pinnedCaption.at).toLocaleString()}) is kept in the channel.`,
      });
    } else {
      setNotice(null);
    }
    if (opts.release) st.released = true;
    metrics.inc("backup.stored");
    log.info("backup", `index backup stored (${(payload.length / 1024).toFixed(0)} KiB${opts.release ? ", final" : ""})`);
    events.emit({ type: "backup" });
    return { status: opts.release ? "released" : "stored" };
  } catch (e) {
    kv.set("backup.error", (e as Error).message);
    log.error("backup", `backup failed: ${(e as Error).message}`);
    events.emit({ type: "backup" });
    return { status: "failed", message: (e as Error).message };
  }
}

/**
 * Hands the drive over before this server stops: whatever isn't backed up yet
 * is, and the backup is marked final, so the next server (a redeploy, a host
 * waking a sleeping instance) restores it without waiting.
 */
export function releaseDrive(rt: Runtime): Promise<BackupResult> {
  return runBackup(rt, { release: true });
}

// ---------------------------------------------------------------------------
// Following another server
// ---------------------------------------------------------------------------

/**
 * While this server has nothing unsaved and nobody is using it, it follows
 * the pinned backup: if another server built on exactly this server's latest
 * backup (a redeploy that overlapped, or the drive used from another server
 * for a while), this one loads that newer index instead of going stale.
 */
export function followPinned(rt: Runtime): Promise<void> {
  return serial(async () => {
    if (!rt.driver.pinnedPost || st.released || isDirty() || busy()) return;
    const pinned = await rt.driver.pinnedPost();
    const caption = parseBackupCaption(pinned?.caption);
    const verdict = judgePinned(pinned && { m: pinned.id, caption }, { drive: driveId(), branch: branch(), base: base() }).kind;
    if (verdict !== "ahead" || !pinned || !caption) return;
    const raw = await readPost(rt, pinned.ref, pinned.size);
    const sessions: Record<string, string> = {};
    for (const row of sql("SELECT k, v FROM kv WHERE k LIKE 'tg.session.%'").all() as { k: string; v: string }[]) sessions[row.k.slice("tg.session.".length)] = row.v;
    const next = materializeBackup(raw, pinned, caption, { mode: "adopt", sessions });
    if (isDirty() || busy()) {
      fs.rmSync(next.file, { force: true });
      return; // something happened meanwhile: this server's own changes come first
    }
    replaceDatabase(next.file);
    forgetAllBlobMeta();
    events.resetClients();
    log.info("backup", `another server continued from this drive's latest backup — switched to its newer index (post ${pinned.id})`);
  });
}

// ---------------------------------------------------------------------------

export function backupStatus() {
  const cfg = config();
  const open = databaseOpen();
  const read = <T>(k: string): T | null => {
    if (!open) return null;
    const raw = kv.get(k);
    return raw ? (JSON.parse(raw) as T) : null;
  };
  const last = read<HistoryEntry>("backup.last");
  const restore = read<{ at: number; messageId: number; backupAt: number; mode: string }>("restore.last");
  return {
    enabled: cfg.durability.backups,
    lastAt: last?.at ?? null,
    lastSize: last?.size ?? null,
    lastError: open ? (kv.get("backup.error") ?? null) : null,
    pending: open ? isDirty() : false,
    notice: read<BackupNotice>("backup.notice"),
    restoredAt: restore?.at ?? null,
    restoredBackupAt: restore?.backupAt ?? null,
    released: st.released,
  };
}

/** Test/diagnostic view of the pinned backup. */
export async function pinnedBackup(rt: Runtime): Promise<{ post: ChannelPost; caption: BackupCaption } | null> {
  const post = (await rt.driver.pinnedPost?.()) ?? null;
  const caption = parseBackupCaption(post?.caption);
  return post && caption ? { post, caption } : null;
}
