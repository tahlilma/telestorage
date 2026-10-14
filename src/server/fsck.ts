import "server-only";
import type { FsckReport } from "@/lib/types";
import { db, kv, sql, tx } from "./db";
import { emitNodes } from "./events";
import { log, metrics } from "./metrics";
import { forgetBlobMeta } from "./storage/blobs";

type Check = FsckReport["checks"][number];

const REACHABLE = `WITH RECURSIVE r(id) AS (
  SELECT 'root'
  UNION ALL SELECT n.id FROM nodes n JOIN r ON n.parent_id = r.id
)`;

/**
 * Preemptive consistency checker for the metadata index ("fsck"). Runs at
 * boot and periodically; every invariant the rest of the code relies on is
 * verified here, and violations that can be fixed safely are repaired.
 */
export function runFsck(opts: { repair: boolean }): FsckReport {
  const t0 = performance.now();
  const checks: Check[] = [];
  let needsGc = false;
  let treeChanged = false;
  const add = (name: string, status: Check["status"], count: number, detail: string) => checks.push({ name, status, count, detail });

  // 1. Page-level integrity of the SQLite file.
  const quick = sql("PRAGMA quick_check").pluck().all() as string[];
  if (quick.length === 1 && quick[0] === "ok") add("Database file", "ok", 0, "SQLite quick_check passed");
  else add("Database file", "error", quick.length, quick.slice(0, 3).join("; "));

  // 2. Dangling foreign keys in auxiliary tables.
  // These tables are WITHOUT ROWID (foreign_key_check reports no rowid), so each
  // gets an explicit repair statement keyed on its foreign key.
  const REPAIRS: Record<string, string> = {
    blob_parts: "DELETE FROM blob_parts WHERE blob_id NOT IN (SELECT id FROM blobs)",
    thumbs: "DELETE FROM thumbs WHERE blob_id NOT IN (SELECT id FROM blobs)",
    share_items: "DELETE FROM share_items WHERE node_id NOT IN (SELECT id FROM nodes) OR share_id NOT IN (SELECT id FROM shares)",
    versions: "DELETE FROM versions WHERE node_id NOT IN (SELECT id FROM nodes) OR blob_id NOT IN (SELECT id FROM blobs)",
    upload_parts: "DELETE FROM upload_parts WHERE upload_id NOT IN (SELECT id FROM upload_sessions)",
    upload_pieces: "DELETE FROM upload_pieces WHERE upload_id NOT IN (SELECT id FROM upload_sessions)",
  };
  const fk = db().pragma("foreign_key_check") as { table: string }[];
  const dangling = fk.filter((r) => r.table in REPAIRS);
  if (dangling.length && opts.repair) {
    const removed = tx(() => [...new Set(dangling.map((r) => r.table))].reduce((n, t) => n + sql(REPAIRS[t]).run().changes, 0));
    add("Foreign keys", "repaired", removed, "Removed rows pointing at deleted records");
  } else {
    add("Foreign keys", dangling.length ? "warning" : "ok", dangling.length, dangling.length ? "Rows point at deleted records" : "All references resolve");
  }

  // 3. Root sanity: never trashed, never parented.
  const rootFix = sql("UPDATE nodes SET trashed_at = NULL, in_trash = 0, parent_id = NULL WHERE id = 'root' AND (trashed_at IS NOT NULL OR in_trash <> 0 OR parent_id IS NOT NULL)");
  const rootChanged = opts.repair ? rootFix.run().changes : 0;
  add("Root folder", rootChanged ? "repaired" : "ok", rootChanged, rootChanged ? "Root folder flags reset" : "Root folder is intact");

  // 4. Every node must be reachable from the root (no orphans, no cycles).
  const unreachable = () => sql(`${REACHABLE} SELECT id FROM nodes WHERE id NOT IN (SELECT id FROM r)`).pluck().all() as string[];
  let lost = unreachable();
  if (lost.length && opts.repair) {
    const fixed = tx(() => {
      let moved = 0;
      for (let round = 0; round < 64 && lost.length; round++) {
        const set = new Set(lost);
        // Orphans (missing parent) first; then break one link of each remaining cycle.
        const tops = sql("SELECT id FROM nodes WHERE id IN (SELECT value FROM json_each(?)) AND (parent_id IS NULL OR parent_id NOT IN (SELECT id FROM nodes))")
          .pluck()
          .all(JSON.stringify(lost)) as string[];
        const targets = tops.length ? tops : [lost.find((id) => set.has(id))!];
        sql("UPDATE nodes SET parent_id = 'root' WHERE id IN (SELECT value FROM json_each(?))").run(JSON.stringify(targets));
        moved += targets.length;
        lost = unreachable();
      }
      return moved;
    });
    treeChanged = true;
    add("Tree structure", "repaired", fixed, `Re-attached ${fixed} unreachable item(s) to the root`);
  } else {
    add("Tree structure", lost.length ? "error" : "ok", lost.length, lost.length ? "Items are not reachable from the root" : "Every item is reachable");
  }

  // 5. Trash flags: in_trash must equal "this node or an ancestor was trashed".
  const wrongTrash = sql(
    `WITH RECURSIVE t(id, flag) AS (
       SELECT 'root', 0
       UNION ALL SELECT n.id, (t.flag OR n.trashed_at IS NOT NULL) FROM nodes n JOIN t ON n.parent_id = t.id
     ) SELECT n.id, t.flag FROM nodes n JOIN t ON t.id = n.id WHERE n.in_trash <> t.flag`,
  ).all() as { id: string; flag: number }[];
  if (wrongTrash.length && opts.repair) {
    tx(() => {
      const fix = sql("UPDATE nodes SET in_trash = ? WHERE id = ?");
      for (const r of wrongTrash) fix.run(r.flag, r.id);
    });
    treeChanged = true;
    add("Trash flags", "repaired", wrongTrash.length, "Recomputed trash visibility");
  } else {
    add("Trash flags", wrongTrash.length ? "warning" : "ok", wrongTrash.length, wrongTrash.length ? "Trash visibility is inconsistent" : "Consistent");
  }

  // 6. Files must point at existing blobs.
  const brokenFiles = sql(
    "SELECT COUNT(*) FROM nodes n LEFT JOIN blobs b ON b.id = n.blob_id WHERE n.kind = 'file' AND (n.blob_id IS NULL OR b.id IS NULL)",
  )
    .pluck()
    .get() as number;
  add("File contents", brokenFiles ? "error" : "ok", brokenFiles, brokenFiles ? "Files whose stored content is missing" : "Every file has stored content");

  // 7. Blobs nobody references any more (no file, no kept version) are deleted from storage.
  const orphans = sql(
    `SELECT id, driver FROM blobs b
     WHERE NOT EXISTS (SELECT 1 FROM nodes n WHERE n.blob_id = b.id)
       AND NOT EXISTS (SELECT 1 FROM versions v WHERE v.blob_id = b.id)`,
  ).all() as { id: string; driver: string }[];
  if (orphans.length && opts.repair) {
    tx(() => {
      const enqueue = sql("INSERT INTO gc_queue (driver, blob_id, ref, next_at) SELECT ?, blob_id, ref, ? FROM blob_parts WHERE blob_id = ?");
      const del = sql("DELETE FROM blobs WHERE id = ?");
      for (const o of orphans) {
        enqueue.run(o.driver, Date.now(), o.id);
        del.run(o.id);
        forgetBlobMeta(o.id);
      }
    });
    needsGc = true;
    add("Unreferenced content", "repaired", orphans.length, "Queued for removal from storage");
  } else {
    add("Unreferenced content", orphans.length ? "warning" : "ok", orphans.length, orphans.length ? "Stored content no file points to" : "None");
  }

  // 8. Part bookkeeping.
  const badParts = sql("SELECT COUNT(*) FROM blobs b WHERE b.part_count <> (SELECT COUNT(*) FROM blob_parts p WHERE p.blob_id = b.id)").pluck().get() as number;
  add("Part bookkeeping", badParts ? "error" : "ok", badParts, badParts ? "Blobs with missing part records" : "Every part is accounted for");

  // 9. Full-text search index.
  try {
    // rank = 1 also compares the index with the nodes table (not just its internal structure).
    sql("INSERT INTO nodes_fts(nodes_fts, rank) VALUES ('integrity-check', 1)").run();
    add("Search index", "ok", 0, "FTS5 index matches the tree");
  } catch (e) {
    if (opts.repair) {
      sql("INSERT INTO nodes_fts(nodes_fts) VALUES ('rebuild')").run();
      add("Search index", "repaired", 1, "Rebuilt the FTS5 index");
    } else {
      add("Search index", "error", 1, (e as Error).message);
    }
  }

  // 10. Storage health signals from other subsystems.
  const stuckGc = sql("SELECT COUNT(*) FROM gc_queue WHERE attempts >= 8").pluck().get() as number;
  add("Deletion queue", stuckGc ? "warning" : "ok", stuckGc, stuckGc ? "Parts that repeatedly failed to delete" : "Draining normally");
  const corrupt = sql("SELECT COUNT(*) FROM blobs WHERE corrupt_at IS NOT NULL").pluck().get() as number;
  add("Read-back verification", corrupt ? "error" : "ok", corrupt, corrupt ? "Files failed whole-file SHA-256 verification" : "No corruption detected");

  const repaired = checks.filter((c) => c.status === "repaired").reduce((n, c) => n + c.count, 0);
  if (repaired) {
    metrics.inc("fsck.repairs", repaired);
    log.warn("fsck", `repaired ${repaired} inconsistenc${repaired === 1 ? "y" : "ies"}`);
  }
  if (treeChanged) emitNodes("repair", { parents: ["root"] });
  const report: FsckReport = {
    at: Date.now(),
    durationMs: Math.round(performance.now() - t0),
    ok: checks.every((c) => c.status === "ok" || c.status === "repaired"),
    repaired,
    checks,
    needsGc,
  };
  kv.set("fsck.last", JSON.stringify(report));
  return report;
}

export function lastFsck(): FsckReport | null {
  const raw = kv.get("fsck.last");
  return raw ? (JSON.parse(raw) as FsckReport) : null;
}
