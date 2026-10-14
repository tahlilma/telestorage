import "server-only";
import fs from "node:fs";
import os from "node:os";
import { MAX_FILE_SIZE } from "@/lib/protocol";
import type { Capacity, SystemSnapshot } from "@/lib/types";
import { config } from "./config";
import { sql } from "./db";
import { metrics } from "./metrics";
import { admissionStats } from "./admission";
import { lastFsck } from "./fsck";
import type { Runtime } from "./storage";
import { backupStatus } from "./storage/backup";
import { scrubStatus } from "./storage/maintenance";

type StorageStats = SystemSnapshot["storage"];
let storageCache: { at: number; value: StorageStats } | null = null;

/** Telegram message ids are signed 32-bit integers, and a channel never reuses one. */
const POST_ID_LIMIT = 2 ** 31 - 1;
/** Largest document a bot may upload: 4 000 parts of 512 KiB. */
const TELEGRAM_MAX_PART = 4000 * 512 * 1024;

/** The real ceilings (see Capacity in types.ts). Nothing here is an estimate except "posts used". */
function capacity(): Capacity {
  const cfg = config();
  const base = { partSize: cfg.tg.partSize, maxPartSize: TELEGRAM_MAX_PART, maxFileSize: MAX_FILE_SIZE };
  if (cfg.driver === "telegram") {
    // Every post ever made in the channel (ours or not, deleted or not) used a
    // number; the highest one this drive has seen is a lower bound for that.
    const seen = sql(
      `SELECT MAX(m) FROM (
         SELECT CAST(json_extract(ref, '$.m') AS INTEGER) AS m FROM blob_parts
         UNION ALL SELECT CAST(json_extract(ref, '$.m') AS INTEGER) FROM upload_parts WHERE ref IS NOT NULL
         UNION ALL SELECT CAST(json_extract(ref, '$.m') AS INTEGER) FROM gc_queue)`,
    )
      .pluck()
      .get() as number | null;
    const postsUsed = seen ?? 0;
    return {
      ...base,
      kind: "telegram",
      postsUsed,
      postLimit: POST_ID_LIMIT,
      postsPerMinute: Math.round(cfg.tg.commitsPerMinute * cfg.tg.botTokens.length),
      freeBytes: (POST_ID_LIMIT - postsUsed) * cfg.tg.partSize,
      totalBytes: null,
    };
  }
  let disk: { freeBytes: number | null; totalBytes: number | null } = { freeBytes: null, totalBytes: null };
  try {
    const s = fs.statfsSync(cfg.dataDir);
    disk = { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  } catch {
    /* unknown */
  }
  return { ...base, kind: "disk", postsUsed: null, postLimit: null, postsPerMinute: null, ...disk };
}

function fileSize(p: string) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

/** Aggregate queries scan the tree, so they are cached for a few seconds. */
function storageStats(): StorageStats {
  if (storageCache && Date.now() - storageCache.at < 5000) return storageCache.value;
  const t = sql(
    `SELECT
       COALESCE(SUM(kind = 'file' AND in_trash = 0), 0) AS files,
       COALESCE(SUM(kind = 'folder' AND in_trash = 0), 0) - 1 AS folders,
       COALESCE(SUM(CASE WHEN kind = 'file' AND in_trash = 0 THEN size END), 0) AS logical,
       COALESCE(SUM(CASE WHEN kind = 'file' AND in_trash = 1 THEN size END), 0) AS trashed,
       COALESCE(SUM(CASE WHEN kind = 'file' THEN size END), 0) AS allLogical
     FROM nodes`,
  ).get() as { files: number; folders: number; logical: number; trashed: number; allLogical: number };
  const b = sql("SELECT COUNT(*) AS blobs, COALESCE(SUM(size), 0) AS physical FROM blobs").get() as { blobs: number; physical: number };
  const byType = sql(
    `SELECT CASE
        WHEN mime LIKE 'image/%' THEN 'Images'
        WHEN mime LIKE 'video/%' THEN 'Videos'
        WHEN mime LIKE 'audio/%' THEN 'Audio'
        WHEN mime LIKE 'text/%' OR mime IN ('application/pdf', 'application/json', 'application/msword', 'application/rtf')
          OR mime LIKE 'application/vnd.openxmlformats%' OR mime LIKE 'application/vnd.oasis%' OR mime LIKE 'application/vnd.ms-%' THEN 'Documents'
        WHEN mime IN ('application/zip', 'application/x-7z-compressed', 'application/x-rar-compressed', 'application/vnd.rar',
          'application/gzip', 'application/x-tar', 'application/x-bzip2', 'application/x-xz') THEN 'Archives'
        ELSE 'Other' END AS type,
       COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS count
     FROM nodes WHERE kind = 'file' AND in_trash = 0 GROUP BY 1 ORDER BY bytes DESC`,
  ).all() as StorageStats["byType"];
  const dbPath = config().dbPath;
  const value: StorageStats = {
    files: t.files,
    folders: Math.max(0, t.folders),
    logicalBytes: t.logical,
    physicalBytes: b.physical,
    blobs: b.blobs,
    parts: sql("SELECT COUNT(*) FROM blob_parts").pluck().get() as number,
    trashedBytes: t.trashed,
    dedupSavedBytes: Math.max(0, t.allLogical - b.physical),
    dbBytes: fileSize(dbPath),
    walBytes: fileSize(`${dbPath}-wal`),
    thumbBytes: sql("SELECT COALESCE(SUM(length(data)), 0) FROM thumbs").pluck().get() as number,
    shares: sql("SELECT COUNT(*) FROM shares").pluck().get() as number,
    gcPending: sql("SELECT COUNT(*) FROM gc_queue").pluck().get() as number,
    byType,
    capacity: capacity(),
  };
  storageCache = { at: Date.now(), value };
  return value;
}

export function invalidateStorageStats() {
  storageCache = null;
}

export function systemSnapshot(rt: Runtime): SystemSnapshot {
  const cfg = config();
  const mem = process.memoryUsage();
  const status = rt.driver.status();
  return {
    ts: Date.now(),
    driver: rt.driver.name,
    uptimeSec: Math.round((Date.now() - metrics.startedAt) / 1000),
    node: process.version,
    platform: `${os.type()} ${os.release()} ${os.arch()}`,
    encryption: Boolean(cfg.encryptionKey),
    channel: status.channel,
    bots: status.bots,
    storage: storageStats(),
    cache: rt.cache.stats(),
    counters: { ...metrics.counters },
    gauges: { ...metrics.gauges },
    latency: metrics.latencySnapshot() as SystemSnapshot["latency"],
    process: {
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
      externalBytes: mem.external + mem.arrayBuffers,
      loadAvg: os.loadavg(),
      cpus: os.cpus().length,
    },
    backup: backupStatus(),
    admission: admissionStats(),
    integrity: { ...scrubStatus(), fsck: lastFsck() },
    trashRetentionDays: cfg.trashRetentionDays,
    errors: [...metrics.errorsByCode.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12),
    logs: metrics.logs.slice(-80),
  };
}
