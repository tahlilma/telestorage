import "server-only";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CHUNK_SIZE, PIECE_SIZE } from "@/lib/protocol";

/** Size of each upload.saveBigFilePart piece (shared with the browser engine). */
export { PIECE_SIZE };
/** Telegram's hard cap for bot uploads: 4000 parts × 512 KiB. */
export const TG_MAX_PART_BYTES = 4000 * PIECE_SIZE;
/** Download block size. upload.getFile allows at most 1 MiB, aligned to 1 MiB. */
export const BLOCK_SIZE = 1024 * 1024;
/** Default HTTP chunk size (proxy/CDN friendly, < 100 MB Cloudflare limit); one verification window. */
export const CHUNK_SIZE = DEFAULT_CHUNK_SIZE;

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Environment variable ${name} must be a number, got "${raw}"`);
  return n;
}

function list(name: string): string[] {
  return (process.env[name] ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseEncryptionKey(raw: string | undefined): Buffer | null {
  if (!raw) return null;
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  // Any other string is treated as a passphrase and stretched with scrypt.
  return crypto.scryptSync(raw, "telestorage/v1/encryption", 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

/**
 * Session-signing secret: AUTH_SECRET, else the one kept in DATA_DIR. A host
 * that wipes its disk would lose that file (and sign you out) at every
 * restart, so with Telegram configured and no file yet, it is derived from
 * the bot tokens instead: as secret as they are, and stable across restarts.
 * Changing the password changes it too, which signs out every device.
 */
function authSecret(dataDir: string, tg: { botTokens: string[]; apiHash: string; channelId: string }, password: string): string {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  const file = path.join(dataDir, "auth-secret.key");
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    /* none yet */
  }
  if (tg.botTokens.length && tg.apiHash) {
    return crypto
      .createHmac("sha256", [...tg.botTokens].sort().join(","))
      .update(`telestorage/auth-secret/v1|${tg.apiHash}|${tg.channelId}|${password}`)
      .digest("base64url");
  }
  const secret = crypto.randomBytes(48).toString("base64url");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

/** RAM this process may use: the container's cgroup limit if there is one (free hosts: 512 MiB), else the machine's. */
function memoryLimitBytes(): number {
  const fromEnv = Number(process.env.MEMORY_LIMIT_MB);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv * 1024 * 1024;
  const read = (file: string) => {
    try {
      return fs.readFileSync(file, "utf8").trim();
    } catch {
      return null;
    }
  };
  let limit = os.totalmem();
  for (const raw of [read("/sys/fs/cgroup/memory.max"), read("/sys/fs/cgroup/memory/memory.limit_in_bytes")]) {
    const n = Number(raw);
    // cgroup v1 reports "no limit" as a huge number, v2 as "max".
    if (raw && raw !== "max" && Number.isFinite(n) && n > 0 && n < 2 ** 60) limit = Math.min(limit, n);
  }
  return limit;
}

let clampWarned = false;

function buildConfig() {
  const dataDir = path.resolve(/*turbopackIgnore: true*/ process.env.DATA_DIR || "./data");
  fs.mkdirSync(dataDir, { recursive: true });

  const apiId = int("TG_API_ID", 0);
  const apiHash = process.env.TG_API_HASH ?? "";
  const botTokens = list("TG_BOT_TOKENS");
  const channelId = (process.env.TG_CHANNEL_ID ?? "").trim();
  const telegramConfigured = Boolean(apiId && apiHash && botTokens.length && channelId);

  const requestedDriver = process.env.STORAGE_DRIVER as "telegram" | "local" | "sim" | undefined;
  if (requestedDriver && !["telegram", "local", "sim"].includes(requestedDriver)) {
    throw new Error(`STORAGE_DRIVER must be telegram, local or sim (got "${requestedDriver}")`);
  }
  const driver: "telegram" | "local" | "sim" = requestedDriver ?? (telegramConfigured ? "telegram" : "local");
  if (driver === "telegram" && !telegramConfigured) {
    throw new Error("STORAGE_DRIVER=telegram requires TG_API_ID, TG_API_HASH, TG_BOT_TOKENS and TG_CHANNEL_ID");
  }
  const float = (name: string, fallback: number) => {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };

  // Part size: multiple of 1 MiB (block alignment) and within Telegram's 2000 MiB cap.
  const partMiB = Math.max(1, Math.min(2000, Math.floor(int("TG_PART_SIZE_MB", 512))));

  // Memory budget. Node, Next.js and the Telegram connections take the first
  // ~256 MiB; buffers and caches share what's left, so a 512 MiB free-tier
  // instance shrinks them instead of being killed for running out of memory.
  const MiB = 1024 * 1024;
  const memMiB = Math.floor(memoryLimitBytes() / MiB);
  const spareMiB = Math.max(64, memMiB - 256);
  const small = memMiB < 1024;
  const clamped: string[] = [];
  const fit = (name: string, fallback: number, maxMiB: number) => {
    const wanted = Math.max(0, int(name, fallback));
    const n = Math.min(wanted, Math.floor(maxMiB));
    if (n < wanted && process.env[name]) clamped.push(`${name}=${wanted}→${n}`);
    return n;
  };
  const cacheMiB = fit("CACHE_MEMORY_MB", 256, spareMiB * 0.25);
  const streamMiB = Math.max(8, fit("STREAM_BUFFER_MB", 256, spareMiB * 0.2));
  const uploadMiB = Math.max(16, fit("UPLOAD_BUFFER_MB", 384, spareMiB * 0.3));
  if (clamped.length && !clampWarned) {
    clampWarned = true;
    console.warn(`[telestorage] ${memMiB} MiB of RAM: lowered ${clamped.join(", ")} to fit`);
  }
  const tgSettings = { botTokens, apiHash, channelId: channelId.replace(/^-100/, "") };
  const password = process.env.AUTH_PASSWORD ?? "";
  const backupHours = Math.max(0, float("BACKUP_INTERVAL_HOURS", 6));

  return {
    dataDir,
    dbPath: path.join(dataDir, "telestorage.db"),
    cacheDir: path.join(dataDir, "cache"),
    localBlobDir: path.join(dataDir, "blobs"),
    // Render tells each service its address; elsewhere, set PUBLIC_URL.
    publicUrl: (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, ""),
    driver,
    tg: {
      apiId,
      apiHash,
      botTokens,
      channelId: tgSettings.channelId,
      connectionsPerBot: Math.max(1, Math.min(8, int("TG_CONNECTIONS_PER_BOT", small ? 2 : 4))),
      partSize: partMiB * 1024 * 1024,
      /** In-flight MTProto requests per connection (uploads and downloads share it, by priority). */
      connectionConcurrency: Math.max(1, Math.min(32, int("TG_CONCURRENCY", 8))),
      /** sendMedia pacing per bot; Telegram allows roughly 20 messages a minute per chat for bots. */
      commitsPerMinute: Math.max(1, float("TG_COMMITS_PER_MINUTE", 20)),
      hedging: process.env.TG_HEDGING !== "false",
    },
    sim: {
      bots: Math.max(1, Math.min(16, int("SIM_BOTS", 3))),
      connections: Math.max(1, Math.min(8, int("SIM_CONNECTIONS", 2))),
      latencyMs: Math.max(0, float("SIM_LATENCY_MS", 25)),
      jitterMs: Math.max(0, float("SIM_JITTER_MS", 20)),
      bandwidthBps: Math.max(0, float("SIM_BANDWIDTH_MBPS", 0)) * 1024 * 1024,
      faultRate: Math.max(0, float("SIM_FAULT_RATE", 0)),
      floodRate: Math.max(0, float("SIM_FLOOD_RATE", 0)),
      floodSeconds: Math.max(1, float("SIM_FLOOD_SECONDS", 3)),
      corruptRate: Math.max(0, float("SIM_CORRUPT_RATE", 0)),
      dropRate: Math.max(0, float("SIM_DROP_RATE", 0)),
      slowBot: int("SIM_SLOW_BOT", -1),
      /** How many times slower the slow bot is (latency and bandwidth). */
      slowFactor: Math.max(1, float("SIM_SLOW_FACTOR", 6)),
      stallRate: Math.max(0, float("SIM_STALL_RATE", 0)),
      stallMs: Math.max(0, float("SIM_STALL_MS", 1500)),
      commitsPerMinute: Math.max(1, float("SIM_COMMITS_PER_MINUTE", 600)),
    },
    uploads: {
      /** Bytes of chunk data the server will hold in flight before queueing new chunk requests. */
      admissionBytes: uploadMiB * MiB,
      admissionTimeoutMs: Math.max(1000, int("UPLOAD_QUEUE_TIMEOUT_MS", 15_000)),
      /** Pieces of one chunk uploaded to storage concurrently. */
      piecesPerChunk: Math.max(1, Math.min(16, int("UPLOAD_PIECE_PARALLELISM", 8))),
      /** How long an interrupted upload can be resumed (its finished parts are kept until then). */
      resumeDays: Math.max(1, float("UPLOAD_RESUME_DAYS", 7)),
    },
    integrity: {
      /** Background read-back verification speed in MiB/s (0 disables). Runs only when idle. */
      scrubBytesPerSec: Math.max(0, float("SCRUB_MBPS", driver === "telegram" ? 8 : 64)) * 1024 * 1024,
      fsckIntervalHours: Math.max(0, float("FSCK_INTERVAL_HOURS", 6)),
    },
    trashRetentionDays: Math.max(0, float("TRASH_RETENTION_DAYS", 30)),
    /** Earlier versions kept per file when it's replaced (oldest go first). */
    versionsKeep: Math.max(0, Math.min(1000, int("VERSIONS_KEEP", 25))),
    auth: {
      password,
      secret: authSecret(dataDir, tgSettings, password),
      totpSecret: (process.env.AUTH_TOTP_SECRET ?? "").replace(/\s+/g, "").toUpperCase(),
      sessionDays: Math.max(1, int("SESSION_DAYS", 30)),
    },
    encryptionKey: parseEncryptionKey(process.env.ENCRYPTION_KEY),
    cache: {
      memoryBytes: cacheMiB * MiB,
      diskBytes: Math.max(0, int("CACHE_DISK_GB", small ? 1 : 5)) * 1024 * 1024 * 1024,
    },
    stream: {
      /** Blocks fetched ahead of the reader for each streaming response. */
      readahead: Math.max(1, Math.min(streamMiB, int("STREAM_READAHEAD_BLOCKS", 32))),
      /** Readahead memory shared by all streams, in 1 MiB blocks. */
      bufferBlocks: streamMiB,
    },
    sqlite: {
      cacheBytes: (small ? 16 : 64) * MiB,
      mmapBytes: (small ? 32 : 256) * MiB,
    },
    memory: { limitBytes: memMiB * MiB, small },
    /** Kept for compatibility: 0 turns automatic backups off. */
    backupIntervalHours: backupHours,
    durability: {
      /** Restore the index from Telegram when the server starts without one (a wiped disk). */
      autoRestore: process.env.AUTO_RESTORE !== "false",
      /** Back the index up to the channel automatically (BACKUP_INTERVAL_HOURS=0 turns it off). */
      backups: backupHours > 0,
      /** Changes are backed up once they've been quiet this long… */
      backupDelayMs: Math.max(1, float("BACKUP_DELAY_SEC", 30)) * 1000,
      /** …or after this long at the latest while changes keep coming. */
      backupMaxDelayMs: Math.max(5, float("BACKUP_MAX_DELAY_SEC", 300)) * 1000,
      /**
       * At start, a backup from a server that may still be running (recent, not
       * handed over) is waited on this long, so that server's final changes
       * aren't lost during a redeploy.
       */
      handoverWaitMs: Math.max(0, float("HANDOVER_WAIT_SEC", 60)) * 1000,
    },
    simDir: process.env.SIM_DIR ? path.resolve(/*turbopackIgnore: true*/ process.env.SIM_DIR) : path.join(dataDir, "sim"),
  };
}

export type Config = ReturnType<typeof buildConfig>;

const g = globalThis as unknown as { __tsConfig?: Config };

/** Lazily evaluated so `next build` never needs runtime secrets. */
export function config(): Config {
  return (g.__tsConfig ??= buildConfig());
}
