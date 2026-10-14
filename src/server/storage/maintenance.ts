import "server-only";
import { config } from "../config";
import { db, sql } from "../db";
import { events } from "../events";
import { runFsck } from "../fsck";
import { sweepIdempotency } from "../idempotency";
import { log, metrics } from "../metrics";
import { purgeExpiredTrash } from "../nodes";
import { currentRev, followPinned, isDirty, runBackup } from "./backup";
import { loadBlob, scrubBlob, type Runtime } from "./blobs";
import { recoverUploads, sweepStaleUploads } from "./uploads";

// ---------------------------------------------------------------------------
// Garbage collection: deleted content leaves the Telegram channel immediately.
// ---------------------------------------------------------------------------

interface GcRow {
  id: number;
  driver: string;
  blobId: string;
  ref: string;
  attempts: number;
}

const g = globalThis as unknown as { __tsGc?: { running: Promise<void> | null; again: boolean } };
const gc = (g.__tsGc ??= { running: null, again: false });

async function drainGc(rt: Runtime) {
  for (;;) {
    const rows = sql(
      "SELECT id, driver, blob_id AS blobId, ref, attempts FROM gc_queue WHERE next_at <= ? AND driver = ? ORDER BY id LIMIT 500",
    ).all(Date.now(), rt.driver.name) as GcRow[];
    if (!rows.length) return;
    try {
      await rt.driver.deleteParts(rows.map((r) => r.ref));
    } catch (e) {
      const backoff = sql("UPDATE gc_queue SET attempts = attempts + 1, next_at = ? + (15000 * (1 << MIN(attempts, 10))) WHERE id = ?");
      for (const r of rows) backoff.run(Date.now(), r.id);
      log.warn("gc", `removing ${rows.length} part(s) from storage failed, will retry: ${(e as Error).message}`);
      return;
    }
    sql("DELETE FROM gc_queue WHERE id IN (SELECT value FROM json_each(?))").run(JSON.stringify(rows.map((r) => r.id)));
    const blobs = [...new Set(rows.map((r) => r.blobId))];
    // Deleted content must not linger in the server's caches either.
    for (const blobId of blobs) await rt.cache.forgetBlob(blobId);
    metrics.inc("gc.partsDeleted", rows.length);
    log.info("gc", `removed ${rows.length} part(s) from ${rt.driver.name === "telegram" ? "the Telegram channel" : "storage"}`);
    events.emit({ type: "gc", parts: rows.length, blobs });
  }
}

/** Runs GC now (coalescing concurrent kicks) instead of waiting for the next tick. */
export function kickGc(rt: Runtime): Promise<void> {
  metrics.inc("gc.kicks");
  if (gc.running) {
    gc.again = true;
    return gc.running;
  }
  gc.running = (async () => {
    try {
      do {
        gc.again = false;
        await drainGc(rt);
      } while (gc.again);
    } catch (e) {
      log.error("gc", (e as Error).message);
    } finally {
      gc.running = null;
    }
  })();
  return gc.running;
}

// ---------------------------------------------------------------------------
// Scrubber: read-after-write verification while the server is idle
// ---------------------------------------------------------------------------

let scrubbing = false;

/** Foreground activity in the last 20 s — the scrubber stays out of the way. */
export function foregroundBusy() {
  return metrics.gauges.activeStreams > 0 || Date.now() - metrics.lastForegroundAt < 20_000;
}

export function scrubStatus() {
  const r = sql(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(verified_at IS NOT NULL), 0) AS verified,
            COALESCE(SUM(corrupt_at IS NOT NULL), 0) AS corrupt,
            COALESCE(SUM(sha256 IS NULL), 0) AS legacy
     FROM blobs WHERE size > 0`,
  ).get() as { total: number; verified: number; corrupt: number; legacy: number };
  return { ...r, running: scrubbing, enabled: config().integrity.scrubBytesPerSec > 0 };
}

async function runScrub(rt: Runtime, stopped: () => boolean) {
  const rate = config().integrity.scrubBytesPerSec;
  if (!rate || scrubbing || foregroundBusy()) return;
  scrubbing = true;
  try {
    const ids = sql(
      `SELECT id FROM blobs WHERE sha256 IS NOT NULL AND verified_at IS NULL AND corrupt_at IS NULL AND driver = ? AND size > 0
       ORDER BY created_at LIMIT 25`,
    )
      .pluck()
      .all(rt.driver.name) as string[];
    for (const id of ids) {
      const blob = loadBlob(id);
      if (!blob) continue;
      try {
        const r = await scrubBlob(rt, blob, { bytesPerSec: rate, busy: foregroundBusy, cancelled: stopped });
        if (r === "skipped") break;
      } catch (e) {
        log.warn("scrub", `verification of blob ${id} could not finish: ${(e as Error).message}`);
      }
    }
  } finally {
    scrubbing = false;
  }
}

// ---------------------------------------------------------------------------
// Index backups follow changes (see backup.ts)
// ---------------------------------------------------------------------------

/**
 * Backs the index up once changes have been quiet for BACKUP_DELAY_SEC (or
 * BACKUP_MAX_DELAY_SEC after the first unsaved change, while they keep
 * coming), so a host wiping its disk loses at most that. Failures back off.
 * While nothing here is unsaved, the pinned backup is watched too, in case
 * another server continued from this one's latest (backup.ts followPinned).
 */
function scheduleBackups(rt: Runtime, every: (ms: number, fn: () => Promise<void> | void, immediate?: boolean) => void) {
  const { backupDelayMs, backupMaxDelayMs } = config().durability;
  const s = { rev: currentRev(), changedAt: Date.now(), dirtySince: null as number | null, failures: 0, retryAt: 0, followedAt: 0 };
  const startedAt = Date.now();
  every(2000, async () => {
    const rev = currentRev();
    if (rev !== s.rev) {
      s.rev = rev;
      s.changedAt = Date.now();
    }
    if (!isDirty()) {
      s.dirtySince = null;
      // Watching for a newer line: every 20 s for the first ten minutes (a redeploy's overlap), then every 2 min.
      const interval = Date.now() - startedAt < 10 * 60_000 ? 20_000 : 120_000;
      if (rt.driver.pinnedPost && Date.now() - s.followedAt >= interval) {
        s.followedAt = Date.now();
        await followPinned(rt).catch((e) => log.warn("backup", `checking the pinned backup failed: ${(e as Error).message}`));
      }
      return;
    }
    s.dirtySince ??= Date.now();
    if (Date.now() < s.retryAt) return;
    const quiet = Date.now() - s.changedAt >= backupDelayMs;
    const overdue = Date.now() - s.dirtySince >= backupMaxDelayMs;
    if (!quiet && !overdue) return;
    const r = await runBackup(rt);
    if (r.status === "failed") {
      s.failures++;
      s.retryAt = Date.now() + Math.min(10 * 60_000, 15_000 * 2 ** (s.failures - 1));
    } else {
      s.failures = 0;
      s.retryAt = 0;
    }
  });
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export function startMaintenance(rt: Runtime): () => void {
  const cfg = config();
  const timers: NodeJS.Timeout[] = [];
  let stopped = false;
  const every = (ms: number, fn: () => Promise<void> | void, immediate = false) => {
    let running = false;
    const tick = async () => {
      if (running || stopped) return;
      running = true;
      try {
        await fn();
      } catch (e) {
        log.error("maintenance", (e as Error).message);
      } finally {
        running = false;
      }
    };
    const t = setInterval(tick, ms);
    t.unref();
    timers.push(t);
    if (immediate) setTimeout(tick, 2000).unref();
  };

  recoverUploads();
  every(15_000, () => kickGc(rt), true); // safety net; deletes normally kick GC directly
  every(10 * 60_000, () => sweepStaleUploads(rt));
  every(60 * 60_000, () => sweepIdempotency());
  every(10 * 60_000, () => {
    sql("PRAGMA optimize").run();
    db().pragma("wal_checkpoint(PASSIVE)");
  });
  if (cfg.trashRetentionDays > 0) {
    every(
      60 * 60_000,
      () => {
        const r = purgeExpiredTrash(cfg.trashRetentionDays);
        if (r.nodes) {
          metrics.inc("trash.autoPurged", r.nodes);
          log.info("trash", `deleted ${r.nodes} item(s) older than ${cfg.trashRetentionDays} days`);
          void kickGc(rt);
        }
      },
      true,
    );
  }
  if (cfg.integrity.fsckIntervalHours > 0) {
    every(
      cfg.integrity.fsckIntervalHours * 3600_000,
      () => {
        if (runFsck({ repair: true }).needsGc) void kickGc(rt);
      },
      true,
    );
  }
  if (cfg.integrity.scrubBytesPerSec > 0) every(30_000, () => runScrub(rt, () => stopped));
  if (cfg.durability.backups) scheduleBackups(rt, every);
  return () => {
    stopped = true;
    for (const t of timers) clearInterval(t);
  };
}
