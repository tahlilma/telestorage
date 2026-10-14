import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Upgrade dry run against a COPY of a real database:
 *   REAL_DB=path/to/telestorage.db npx vitest run tests/unit/real-db.test.ts
 * The copy is taken with SQLite's online backup from a read-only connection,
 * so it is consistent even while a server has the database open.
 */
describe.skipIf(!process.env.REAL_DB)("upgrade dry run on a real database copy", () => {
  it("migrates, keeps every node, link and secret, and passes fsck", async () => {
    const dst = path.join(process.env.DATA_DIR!, "telestorage.db");
    const Database = (await import("better-sqlite3")).default;
    const source = new Database(process.env.REAL_DB!, { readonly: true, fileMustExist: true });
    await source.backup(dst);
    source.close();

    const before = new Database(dst, { readonly: true });
    const version = before.pragma("user_version", { simple: true });
    const nodeCount = before.prepare("SELECT COUNT(*) FROM nodes").pluck().get();
    const shareCount = before.prepare("SELECT COUNT(*) FROM shares").pluck().get();
    const kvKeys = before.prepare("SELECT k FROM kv WHERE k NOT LIKE 'fsck.%' ORDER BY k").pluck().all();
    before.close();

    const { db, sql } = await import("@/server/db");
    const { runFsck } = await import("@/server/fsck");
    expect(db().pragma("user_version", { simple: true })).toBe(5);
    expect(sql("SELECT COUNT(*) FROM nodes").pluck().get()).toBe(nodeCount);
    expect(sql("SELECT COUNT(*) FROM shares").pluck().get()).toBe(shareCount);
    expect(sql("SELECT COUNT(DISTINCT share_id) FROM share_items").pluck().get()).toBe(shareCount);
    expect(sql("SELECT k FROM kv WHERE k NOT LIKE 'fsck.%' ORDER BY k").pluck().all()).toEqual(kvKeys);
    expect(sql("SELECT name FROM nodes WHERE id = 'root'").pluck().get()).toBe("My files");
    const report = runFsck({ repair: false });
    console.log(`migrated v${version} → v5 (${nodeCount} nodes, ${shareCount} links); fsck:`, JSON.stringify(report.checks.map((c) => `${c.name}: ${c.status}`)));
    expect(report.checks.filter((c) => c.status === "error")).toEqual([]);
    db().close();
  });
});
