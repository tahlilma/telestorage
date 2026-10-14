import "server-only";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import Database from "better-sqlite3";
import { Api, Logger, TelegramClient, sessions } from "telegram";
import { config } from "../config";
import { SCHEMA_VERSION, allowDatabase, setDatabaseWaitMessage, type DB } from "../db";
import { log } from "../metrics";
import { sleep } from "../sem";
import { botId, openSession, parseBackupCaption, type BackupCaption } from "./backup-format";
import { isSealed, openGcm } from "./crypto";
import { simPinned, simPost } from "./sim";
import { fetchMessages, pinnedMessage, postFromMessage, resolveInputChannel } from "./tg-channel";
import type { ChannelPost } from "./types";

/**
 * Boot-time restore. A host with a throwaway disk (most free tiers) starts
 * the server with no index at all. The files are safe in Telegram, and so is
 * the index — pinned as the latest backup — so before anything is served,
 * this brings that backup back. Until it has, the database stays closed and
 * every request gets "restoring, try again in a moment" (db.ts).
 *
 * It never guesses: if Telegram can't be reached it keeps trying instead of
 * starting an empty drive, which would then be backed up over the real one.
 */

export type RecoveryPhase = "checking" | "waiting" | "restoring" | "ready" | "failed";

export interface RecoveryState {
  phase: RecoveryPhase;
  message: string;
  /** Last error, while retrying or after giving up. */
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
  /** What came back, if anything. */
  restored: { messageId: number; backupAt: number; waitedMs: number; fallback: boolean } | null;
  /** True when the drive started empty on purpose (nothing in Telegram, or a reset). */
  fresh: boolean;
}

/** A problem only a configuration change can fix (no point retrying). */
class ConfigError extends Error {}

const g = globalThis as unknown as { __tsRecovery?: { state: RecoveryState; promise: Promise<void> } };

/** Written by `npm run reset`: start an empty drive even though Telegram has a backup. */
export const FRESH_START_MARKER = "fresh-start.json";

export function recoveryState(): RecoveryState | null {
  return g.__tsRecovery?.state ?? null;
}

/** True once the index is in place (or nothing needed restoring). */
export function recoveryDone(): boolean {
  const s = g.__tsRecovery?.state;
  return !s || s.phase === "ready";
}

function needed(): boolean {
  const cfg = config();
  return cfg.durability.autoRestore && cfg.driver !== "local" && !fs.existsSync(cfg.dbPath);
}

/** Starts the restore if the index is missing; resolves when the database may open. Safe to call often. */
export function ensureRecovery(): Promise<void> {
  if (g.__tsRecovery) return g.__tsRecovery.promise;
  if (!needed()) return Promise.resolve();
  const state: RecoveryState = {
    phase: "checking",
    message: "Looking for your drive's backup in Telegram…",
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
    restored: null,
    fresh: false,
  };
  setDatabaseWaitMessage(state.message);
  const promise = run(state);
  g.__tsRecovery = { state, promise };
  return promise;
}

function set(state: RecoveryState, phase: RecoveryPhase, message: string, error: string | null = null) {
  state.phase = phase;
  state.message = message;
  state.error = error;
  setDatabaseWaitMessage(error ? `${message} (${error})` : message);
}

// ---------------------------------------------------------------------------
// Where backups are read from, before the storage driver (which needs the
// database) can run.
// ---------------------------------------------------------------------------

interface Source {
  pinned(): Promise<ChannelPost | null>;
  post(id: number): Promise<ChannelPost | null>;
  download(post: ChannelPost): Promise<Buffer>;
  /** Sessions it logged in with, by bot id, for the driver to reuse. */
  sessions(): Record<string, string>;
  close(): Promise<void>;
}

/**
 * The pinned post's caption over the HTTP Bot API: no MTProto login needed.
 * The last server left the first bot's session there (sealed with its token),
 * so this server can resume it instead of logging in again — Telegram puts
 * bots that log in too often on a long wait, and free hosts restart a lot.
 */
async function botApiPinnedCaption(token: string, channelId: string): Promise<string | null> {
  const res = await fetch(`https://api.telegram.org/bot${token}/getChat?chat_id=-100${channelId}`, { signal: AbortSignal.timeout(10_000) });
  const body = (await res.json()) as { ok?: boolean; result?: { pinned_message?: { caption?: string } } };
  return body.ok ? (body.result?.pinned_message?.caption ?? null) : null;
}

function newClient(session: string) {
  const { apiId, apiHash } = config().tg;
  return new TelegramClient(new sessions.StringSession(session), apiId, apiHash, {
    connectionRetries: 3,
    retryDelay: 1000,
    floodSleepThreshold: 0,
    deviceModel: "telestorage",
    systemVersion: `${process.platform} node ${process.version}`,
    appVersion: "2.0.0",
    baseLogger: new Logger("error" as ConstructorParameters<typeof Logger>[0]),
  });
}

async function telegramSource(): Promise<Source> {
  const tg = config().tg;
  const token = tg.botTokens[0];
  let session = "";
  try {
    const s0 = parseBackupCaption(await botApiPinnedCaption(token, tg.channelId))?.s0;
    if (s0) session = openSession(token, s0) ?? "";
  } catch {
    /* Bot API unreachable: an MTProto login below works too */
  }
  let client = newClient(session);
  try {
    await client.start({ botAuthToken: token });
  } catch (e) {
    await client.destroy().catch(() => {});
    if (!session) throw e;
    // The saved session was revoked (or is in use elsewhere): log in afresh.
    client = newClient("");
    await client.start({ botAuthToken: token });
  }
  if (session) log.info("restore", "resumed the first bot's session from the last backup (no new login)");
  const { channel } = await resolveInputChannel(client, tg.channelId);
  return {
    pinned: async () => postFromMessage((await pinnedMessage(client, channel)) ?? undefined, tg.channelId),
    post: async (id) => postFromMessage((await fetchMessages(client, channel, [id]))[0], tg.channelId),
    download: async (post) => {
      const [m] = await fetchMessages(client, channel, [post.id]);
      if (!(m instanceof Api.Message)) throw new Error(`backup post ${post.id} is gone from the channel`);
      const data = await client.downloadMedia(m, {});
      if (!Buffer.isBuffer(data)) throw new Error(`could not download backup post ${post.id}`);
      return data;
    },
    sessions: () => ({ [botId(token)]: (client.session as InstanceType<typeof sessions.StringSession>).save() }),
    close: () => client.destroy(),
  };
}

function simSource(): Source {
  const dir = config().simDir;
  return {
    pinned: async () => simPinned(dir),
    post: async (id) => simPost(dir, id),
    download: (post) => fs.promises.readFile(path.join(dir, `msg-${post.id}`)),
    sessions: () => ({}),
    close: async () => {},
  };
}

// ---------------------------------------------------------------------------
// Turning a backup post back into an index
// ---------------------------------------------------------------------------

export interface Materialized {
  file: string;
  rev: number | null;
}

/**
 * Decrypts, unpacks and checks a backup, then rewrites its bookkeeping for
 * the server taking it over: a new branch (so two servers restored from the
 * same backup can be told apart), the backup it continues from, and the bot
 * sessions unsealed with this server's tokens.
 */
export function materializeBackup(raw: Buffer, post: ChannelPost, caption: BackupCaption, opts: { mode: "boot" | "adopt"; sessions?: Record<string, string> }): Materialized {
  const cfg = config();
  let data = raw;
  if (isSealed(data)) {
    if (!cfg.encryptionKey) throw new ConfigError("Your drive's backup is encrypted: set ENCRYPTION_KEY to the key you used before");
    try {
      data = openGcm(cfg.encryptionKey, data);
    } catch {
      throw new ConfigError("ENCRYPTION_KEY doesn't match the key your drive's backup was made with");
    }
  }
  let bytes: Buffer;
  try {
    bytes = zlib.gunzipSync(data);
  } catch {
    throw new Error(`backup post ${post.id} is damaged (not a valid archive)`);
  }
  const file = path.join(cfg.dataDir, `restore-${Date.now()}-${crypto.randomBytes(3).toString("hex")}.db`);
  fs.writeFileSync(file, bytes);
  let rev: number | null = null;
  const d = new Database(file);
  try {
    if (d.pragma("integrity_check", { simple: true }) !== "ok") throw new Error(`backup post ${post.id} is damaged (integrity check failed)`);
    const version = d.pragma("user_version", { simple: true }) as number;
    if (version > SCHEMA_VERSION) throw new ConfigError("Your drive's backup was made by a newer version of Telestorage — update this server");
    const has = (t: string) => Boolean(d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));
    if (!has("nodes") || !has("kv")) throw new Error(`backup post ${post.id} is not a Telestorage index`);
    rev = has("drive_rev") ? ((d.prepare("SELECT rev FROM drive_rev WHERE id = 1").pluck().get() as number | undefined) ?? null) : null;

    const get = (k: string) => (d.prepare("SELECT v FROM kv WHERE k = ?").pluck().get(k) as string | undefined) ?? null;
    const put = d.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v");
    d.transaction(() => {
      put.run("drive.branch", crypto.randomBytes(6).toString("base64url"));
      put.run("backup.base", JSON.stringify({ m: post.id, br: caption.br, rev: caption.rev ?? rev }));
      // Clean as of the backup: nothing to back up until something changes.
      put.run("backup.rev", String(rev ?? -1));
      const history = JSON.parse(get("backup.history") ?? "[]") as { at: number; size: number; ref?: string }[];
      if (!history.some((h) => h.ref === post.ref)) history.push({ at: caption.at || Date.now(), size: post.size, ref: post.ref });
      put.run("backup.history", JSON.stringify(history));
      put.run("backup.last", JSON.stringify({ at: caption.at || Date.now(), size: post.size, ref: post.ref }));
      put.run("restore.last", JSON.stringify({ at: Date.now(), messageId: post.id, backupAt: caption.at, mode: opts.mode }));
      d.prepare("DELETE FROM kv WHERE k IN ('backup.error', 'backup.notice', 'backup.allowReplace')").run();

      // Bot sessions: the backup carries them sealed with each bot's own token.
      const unsealed: Record<string, string> = {};
      for (const token of cfg.tg.botTokens) {
        const sealed = get(`tg.vault.${botId(token)}`);
        const session = sealed ? openSession(token, sealed) : null;
        if (session) unsealed[botId(token)] = session;
      }
      d.prepare("DELETE FROM kv WHERE k LIKE 'tg.vault.%' OR k LIKE 'tg.session.%'").run();
      for (const [id, session] of Object.entries({ ...unsealed, ...opts.sessions })) put.run(`tg.session.${id}`, session);
    })();
  } catch (e) {
    d.close();
    fs.rmSync(file, { force: true });
    throw e;
  }
  d.close();
  return { file, rev };
}

// ---------------------------------------------------------------------------

/** A backup this recent, not marked as handed over, may come from a server that is still running. */
const RECENT_MS = 10 * 60_000;

async function run(state: RecoveryState): Promise<void> {
  const cfg = config();
  const marker = path.join(cfg.dataDir, FRESH_START_MARKER);
  if (fs.existsSync(marker)) {
    // `npm run reset`: an empty drive was asked for. Its first backup may replace the pinned one.
    fs.rmSync(marker, { force: true });
    log.warn("restore", "starting an empty drive (reset) — the backup in Telegram is not restored");
    finish(state, { fresh: true }, (d) => d.prepare("INSERT INTO kv (k, v) VALUES ('backup.allowReplace', 'any') ON CONFLICT(k) DO UPDATE SET v = excluded.v").run());
    return;
  }

  for (let attempt = 0; ; attempt++) {
    let source: Source | null = null;
    try {
      set(state, "checking", "Looking for your drive's backup in Telegram…");
      source = cfg.driver === "telegram" ? await telegramSource() : simSource();
      let pinned = await source.pinned();
      let caption = parseBackupCaption(pinned?.caption);
      if (!pinned || !caption) {
        log.info("restore", "no backup pinned in the channel — starting a new drive");
        const handed = source.sessions();
        finish(state, { fresh: true }, (d) => writeSessions(d, handed));
        return;
      }

      // A server that may still be running (a redeploy starts the new one
      // first): give it a moment to hand over, so its last changes come too.
      const t0 = Date.now();
      if (!caption.rel && caption.v >= 3 && Date.now() - caption.at < RECENT_MS && cfg.durability.handoverWaitMs > 0) {
        set(state, "waiting", "Waiting for the previous server to hand over…");
        log.info("restore", "latest backup is recent and not handed over — waiting for the previous server");
        while (Date.now() - t0 < cfg.durability.handoverWaitMs) {
          await sleep(2000);
          const next = await source.pinned();
          const nextCaption = parseBackupCaption(next?.caption);
          if (!next || !nextCaption) continue;
          if (next.id !== pinned.id || nextCaption.rel !== caption.rel) {
            pinned = next;
            caption = nextCaption;
          }
          if (caption.rel) break;
        }
      }
      const waitedMs = Date.now() - t0;

      // The pinned backup, or — if it's damaged — the ones it continues from.
      set(state, "restoring", "Restoring your drive from Telegram…");
      let candidate: { post: ChannelPost; caption: BackupCaption } | null = { post: pinned, caption };
      let fallback = false;
      let restored: Materialized | null = null;
      for (let hops = 0; candidate && hops < 4; hops++) {
        try {
          restored = materializeBackup(await source.download(candidate.post), candidate.post, candidate.caption, { mode: "boot", sessions: source.sessions() });
          break;
        } catch (e) {
          if (e instanceof ConfigError) throw e;
          log.error("restore", `${(e as Error).message}${candidate.caption.par ? " — trying the backup before it" : ""}`);
          const parent: ChannelPost | null = candidate.caption.par ? await source.post(candidate.caption.par) : null;
          const parentCaption = parseBackupCaption(parent?.caption);
          candidate = parent && parentCaption ? { post: parent, caption: parentCaption } : null;
          fallback = true;
        }
      }
      if (!restored || !candidate) throw new ConfigError("The backups in Telegram are damaged — restore one by hand (npm run restore) or start fresh (AUTO_RESTORE=false)");

      for (const ext of ["", "-wal", "-shm"]) fs.rmSync(cfg.dbPath + ext, { force: true });
      fs.renameSync(restored.file, cfg.dbPath);
      state.restored = { messageId: candidate.post.id, backupAt: candidate.caption.at, waitedMs, fallback };
      log.info(
        "restore",
        `restored the index from backup post ${candidate.post.id} (made ${Math.round((Date.now() - candidate.caption.at) / 1000)} s ago${waitedMs > 1000 ? `, waited ${Math.round(waitedMs / 1000)} s for hand-over` : ""})`,
      );
      finish(state, { fresh: false });
      return;
    } catch (e) {
      const msg = (e as Error).message || String(e);
      if (e instanceof ConfigError) {
        set(state, "failed", "Can't restore your drive", msg);
        log.error("restore", msg);
        return new Promise<void>(() => {}); // stays closed: only a configuration change can fix this
      }
      const wait = Math.min(60_000, 3000 * 2 ** Math.min(attempt, 5));
      set(state, "checking", `Can't reach Telegram to restore your drive — trying again in ${Math.round(wait / 1000)} s`, msg);
      log.warn("restore", `attempt ${attempt + 1} failed: ${msg}`);
      await sleep(wait);
    } finally {
      await source?.close().catch(() => {});
    }
  }
}

function writeSessions(d: DB, handed: Record<string, string>) {
  const put = d.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v");
  for (const [id, session] of Object.entries(handed)) put.run(`tg.session.${id}`, session);
}

function finish(state: RecoveryState, result: { fresh: boolean }, onOpen?: (d: DB) => void) {
  state.fresh = result.fresh;
  state.finishedAt = Date.now();
  set(state, "ready", result.fresh ? "New drive" : "Restored from Telegram");
  allowDatabase(onOpen);
}
