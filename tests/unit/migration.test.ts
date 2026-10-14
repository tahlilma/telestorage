import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

describe("schema migrations v1 → v3", () => {
  it("upgrades a v1 database in place, preserving data and retiring old upload sessions safely", async () => {
    const { MIGRATIONS_V1 } = await import("@/server/db");
    const file = path.join(process.env.DATA_DIR!, "telestorage.db");
    fs.mkdirSync(process.env.DATA_DIR!, { recursive: true });

    // Build a realistic v1 database by hand.
    const v1 = new Database(file);
    v1.exec(MIGRATIONS_V1[1]);
    v1.pragma("user_version = 1");
    const now = Date.now();
    v1.prepare("INSERT INTO nodes (id, parent_id, kind, name, created_at, updated_at, touched_at) VALUES ('root', NULL, 'folder', 'My Drive', ?, ?, ?)").run(now, now, now);
    v1.prepare("INSERT INTO nodes (id, parent_id, kind, name, created_at, updated_at, touched_at) VALUES ('keep', 'root', 'folder', 'Photos', ?, ?, ?)").run(now, now, now);
    v1.prepare("INSERT INTO kv (k, v) VALUES ('tg.session.42', 'secret-session')").run();
    // A v1 share link: one node, an expiry, some downloads.
    v1.prepare("INSERT INTO shares (id, node_id, created_at, expires_at, downloads) VALUES ('ShareLinkToken0001', 'keep', ?, ?, 3)").run(now, now + 86_400_000);
    // An in-flight v1 upload with one committed Telegram part that would otherwise leak.
    v1.prepare("INSERT INTO uploads (id, state, updated_at) VALUES ('u1', ?, ?)").run(
      JSON.stringify({ blobId: "b1", parts: [{ ref: JSON.stringify({ c: "1", m: 777 }) }, { ref: null }] }),
      now,
    );
    v1.close();

    const { db, sql, SCHEMA_VERSION } = await import("@/server/db");
    expect(db().pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(sql("SELECT name FROM nodes WHERE id = 'root'").pluck().get()).toBe("My files");
    expect(sql("SELECT name FROM nodes WHERE id = 'keep'").pluck().get()).toBe("Photos");
    expect(sql("SELECT v FROM kv WHERE k = 'tg.session.42'").pluck().get()).toBe("secret-session");
    expect(sql("SELECT driver, ref FROM gc_queue").all()).toEqual([{ driver: "telegram", ref: JSON.stringify({ c: "1", m: 777 }) }]);
    const tables = sql("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all() as string[];
    expect(tables).toEqual(expect.arrayContaining(["upload_sessions", "upload_parts", "upload_pieces", "idempotency"]));
    expect(tables).not.toContain("uploads");
    const cols = (sql("PRAGMA table_info(blobs)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["sha256", "verified_at", "corrupt_at"]));
    // v3: the link survives as a one-item link with default options.
    expect(sql("SELECT id, downloads, allow_download, password_hash, views FROM shares").all()).toEqual([
      { id: "ShareLinkToken0001", downloads: 3, allow_download: 1, password_hash: null, views: 0 },
    ]);
    expect(sql("SELECT share_id, node_id FROM share_items").all()).toEqual([{ share_id: "ShareLinkToken0001", node_id: "keep" }]);
    expect(tables).toEqual(expect.arrayContaining(["share_items", "activity"]));
    expect(db().pragma("foreign_key_check")).toEqual([]);
    db().close();
  });
});
