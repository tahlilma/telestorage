import "server-only";
import crypto from "node:crypto";
import fs from "node:fs";
import Database from "better-sqlite3";
import { config } from "./config";
import { RestoringError } from "./storage/types";

export type DB = Database.Database;

export const SCHEMA_VERSION = 6;

/** Bumps the change counter (drive_rev) from inside a trigger. */
const BUMP = "UPDATE drive_rev SET rev = rev + 1 WHERE id = 1;";
const changed = (cols: string[]) => cols.map((c) => `old.${c} IS NOT new.${c}`).join(" OR ");

/** v1 upload sessions stored committed part refs in JSON; queue them for deletion before dropping. */
function retireV1Uploads(db: DB) {
  const rows = db.prepare("SELECT state FROM uploads").all() as { state: string }[];
  const enqueue = db.prepare("INSERT INTO gc_queue (driver, blob_id, ref, next_at) VALUES (?, ?, ?, ?)");
  for (const row of rows) {
    try {
      const st = JSON.parse(row.state) as { blobId: string; parts: { ref: string | null }[] };
      for (const p of st.parts) {
        if (!p.ref) continue;
        const parsed = JSON.parse(p.ref) as { m?: number; f?: string };
        enqueue.run(parsed.m !== undefined ? "telegram" : "local", st.blobId, p.ref, Date.now());
      }
    } catch {
      /* unreadable legacy session: nothing to salvage */
    }
  }
  db.exec("DROP TABLE uploads");
}

const MIGRATIONS: Record<number, (string | ((db: DB) => void))[]> = {
  2: [
    /* sql */ `
    -- Integrity: whole-file SHA-256 (dedup identity) and per-piece SHA-256 of stored bytes.
    ALTER TABLE blobs ADD COLUMN sha256 TEXT;
    ALTER TABLE blobs ADD COLUMN verified_at INTEGER;
    ALTER TABLE blobs ADD COLUMN corrupt_at INTEGER;
    CREATE INDEX blobs_sha256 ON blobs(sha256, size) WHERE sha256 IS NOT NULL;
    ALTER TABLE blob_parts ADD COLUMN piece_hashes BLOB;

    -- Upload sessions as an explicit state machine with row-level progress.
    CREATE TABLE upload_sessions (
      id          TEXT PRIMARY KEY,
      idem_key    TEXT UNIQUE,
      state       TEXT NOT NULL CHECK (state IN ('active', 'completing', 'completed', 'deduped', 'aborted')),
      meta        TEXT NOT NULL,
      result      TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    ) WITHOUT ROWID;
    CREATE INDEX upload_sessions_age ON upload_sessions(state, updated_at);

    CREATE TABLE upload_parts (
      upload_id     TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
      idx           INTEGER NOT NULL,
      size          INTEGER NOT NULL,
      driver_state  TEXT,
      ref           TEXT,
      PRIMARY KEY (upload_id, idx)
    ) WITHOUT ROWID;

    CREATE TABLE upload_pieces (
      upload_id      TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
      part           INTEGER NOT NULL,
      piece          INTEGER NOT NULL,
      plain_sha256   BLOB NOT NULL,
      stored_sha256  BLOB NOT NULL,
      PRIMARY KEY (upload_id, part, piece)
    ) WITHOUT ROWID;

    -- Replay protection for retried POSTs (Idempotency-Key header).
    CREATE TABLE idempotency (
      key         TEXT PRIMARY KEY,
      status      INTEGER NOT NULL,
      body        TEXT NOT NULL,
      created_at  INTEGER NOT NULL
    ) WITHOUT ROWID;

    UPDATE nodes SET name = 'Hangar' WHERE id = 'root' AND name = 'My Drive';
  `,
    retireV1Uploads,
  ],
  3: [
    /* sql */ `
    -- Share links: several items per link, access options and statistics.
    -- (Rebuilt rather than altered: a link no longer belongs to a single node.)
    CREATE TABLE shares_v3 (
      id              TEXT PRIMARY KEY,
      title           TEXT,
      note            TEXT,
      password_hash   TEXT,
      allow_download  INTEGER NOT NULL DEFAULT 1,
      max_downloads   INTEGER,
      created_at      INTEGER NOT NULL,
      expires_at      INTEGER,
      downloads       INTEGER NOT NULL DEFAULT 0,
      views           INTEGER NOT NULL DEFAULT 0,
      last_access_at  INTEGER
    ) WITHOUT ROWID;
    INSERT INTO shares_v3 (id, created_at, expires_at, downloads) SELECT id, created_at, expires_at, downloads FROM shares;
    CREATE TEMP TABLE share_items_v3 AS SELECT id AS share_id, node_id, 0 AS position FROM shares;
    DROP TABLE shares;
    ALTER TABLE shares_v3 RENAME TO shares;
    CREATE TABLE share_items (
      share_id  TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
      node_id   TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      position  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (share_id, node_id)
    ) WITHOUT ROWID;
    CREATE INDEX share_items_node ON share_items(node_id);
    INSERT INTO share_items (share_id, node_id, position) SELECT share_id, node_id, position FROM share_items_v3;
    DROP TABLE share_items_v3;

    -- Activity feed (uploads, deletions, links opened…), coalesced and bounded.
    CREATE TABLE activity (
      id         INTEGER PRIMARY KEY,
      at         INTEGER NOT NULL,
      kind       TEXT NOT NULL,
      count      INTEGER NOT NULL DEFAULT 1,
      name       TEXT,
      node_id    TEXT,
      parent_id  TEXT,
      share_id   TEXT,
      detail     TEXT
    );
    CREATE INDEX activity_at ON activity(at DESC);

    UPDATE nodes SET name = 'My files' WHERE id = 'root' AND name IN ('Hangar', 'My Drive');
  `,
  ],
  4: [
    /* sql */ `
    -- Huge files: once a part is durable, its piece checksums move into the part's
    -- row, so an upload keeps per-piece rows only for the few parts in flight.
    ALTER TABLE upload_parts ADD COLUMN plain_hashes BLOB;
    ALTER TABLE upload_parts ADD COLUMN stored_hashes BLOB;
  `,
  ],
  5: [
    /* sql */ `
    -- Version history: replacing a file keeps the file (its links, star, place)
    -- and moves the previous content here. Blobs referenced by a version are
    -- never garbage-collected (no ON DELETE CASCADE on blob_id).
    CREATE TABLE versions (
      id           TEXT PRIMARY KEY,
      node_id      TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      blob_id      TEXT NOT NULL REFERENCES blobs(id),
      size         INTEGER NOT NULL,
      mime         TEXT,
      taken_at     INTEGER,
      created_at   INTEGER NOT NULL,
      replaced_at  INTEGER NOT NULL
    ) WITHOUT ROWID;
    CREATE INDEX versions_node ON versions(node_id, replaced_at DESC);
    CREATE INDEX versions_blob ON versions(blob_id);

    -- Folder colours.
    ALTER TABLE nodes ADD COLUMN color TEXT;

    -- Photos: when a photo or video was taken (from its metadata, read in the
    -- browser at upload), for the timeline. Falls back to the upload time.
    ALTER TABLE nodes ADD COLUMN taken_at INTEGER;
    CREATE INDEX nodes_photos ON nodes(COALESCE(taken_at, created_at) DESC)
      WHERE kind = 'file' AND in_trash = 0 AND (mime LIKE 'image/%' OR mime LIKE 'video/%');

    -- File requests: a link that lets anyone with it upload into one folder
    -- (and see nothing there). Same table as share links, different kind.
    ALTER TABLE shares ADD COLUMN kind TEXT NOT NULL DEFAULT 'share';
    ALTER TABLE shares ADD COLUMN max_bytes INTEGER;
    ALTER TABLE shares ADD COLUMN received INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE shares ADD COLUMN received_bytes INTEGER NOT NULL DEFAULT 0;
  `,
  ],
  6: [
    /* sql */ `
    -- Durability on hosts that wipe their disk: one counter goes up with every
    -- change worth backing up, so the server knows when the index in Telegram
    -- is behind. Bookkeeping (verification times, view counts, recents,
    -- caches, the activity feed) doesn't count.
    CREATE TABLE drive_rev (id INTEGER PRIMARY KEY CHECK (id = 1), rev INTEGER NOT NULL);
    INSERT INTO drive_rev (id, rev) VALUES (1, 0);

    CREATE TRIGGER rev_nodes_ins AFTER INSERT ON nodes BEGIN ${BUMP} END;
    CREATE TRIGGER rev_nodes_del AFTER DELETE ON nodes BEGIN ${BUMP} END;
    CREATE TRIGGER rev_nodes_upd AFTER UPDATE ON nodes
      WHEN ${changed(["parent_id", "kind", "name", "size", "mime", "blob_id", "starred", "trashed_at", "in_trash", "color", "taken_at"])}
      BEGIN ${BUMP} END;

    CREATE TRIGGER rev_blobs_ins AFTER INSERT ON blobs BEGIN ${BUMP} END;
    CREATE TRIGGER rev_blobs_del AFTER DELETE ON blobs BEGIN ${BUMP} END;
    CREATE TRIGGER rev_blobs_upd AFTER UPDATE ON blobs WHEN ${changed(["sha256", "corrupt_at", "enc_iv"])} BEGIN ${BUMP} END;

    CREATE TRIGGER rev_parts_ins AFTER INSERT ON blob_parts BEGIN ${BUMP} END;
    CREATE TRIGGER rev_parts_del AFTER DELETE ON blob_parts BEGIN ${BUMP} END;
    CREATE TRIGGER rev_parts_upd AFTER UPDATE ON blob_parts BEGIN ${BUMP} END;

    CREATE TRIGGER rev_versions_ins AFTER INSERT ON versions BEGIN ${BUMP} END;
    CREATE TRIGGER rev_versions_del AFTER DELETE ON versions BEGIN ${BUMP} END;
    CREATE TRIGGER rev_versions_upd AFTER UPDATE ON versions BEGIN ${BUMP} END;

    CREATE TRIGGER rev_shares_ins AFTER INSERT ON shares BEGIN ${BUMP} END;
    CREATE TRIGGER rev_shares_del AFTER DELETE ON shares BEGIN ${BUMP} END;
    CREATE TRIGGER rev_shares_upd AFTER UPDATE ON shares
      WHEN ${changed(["title", "note", "password_hash", "allow_download", "max_downloads", "expires_at", "downloads", "kind", "max_bytes", "received", "received_bytes"])}
      BEGIN ${BUMP} END;

    CREATE TRIGGER rev_items_ins AFTER INSERT ON share_items BEGIN ${BUMP} END;
    CREATE TRIGGER rev_items_del AFTER DELETE ON share_items BEGIN ${BUMP} END;
    CREATE TRIGGER rev_items_upd AFTER UPDATE ON share_items BEGIN ${BUMP} END;

    -- Uploads survive a restart: a session and every part it made durable.
    CREATE TRIGGER rev_uploads_ins AFTER INSERT ON upload_sessions BEGIN ${BUMP} END;
    CREATE TRIGGER rev_uploads_del AFTER DELETE ON upload_sessions BEGIN ${BUMP} END;
    CREATE TRIGGER rev_uploads_upd AFTER UPDATE ON upload_sessions WHEN ${changed(["state"])} BEGIN ${BUMP} END;
    CREATE TRIGGER rev_upload_parts_upd AFTER UPDATE ON upload_parts WHEN ${changed(["ref"])} BEGIN ${BUMP} END;

    -- Posts waiting to be deleted from the channel must not be forgotten.
    CREATE TRIGGER rev_gc_ins AFTER INSERT ON gc_queue BEGIN ${BUMP} END;

    -- Settings that live in the database.
    CREATE TRIGGER rev_kv_ins AFTER INSERT ON kv WHEN new.k IN ('auth.sessionVersion', 'enc.fingerprint', 'drive.id') BEGIN ${BUMP} END;
    CREATE TRIGGER rev_kv_upd AFTER UPDATE ON kv WHEN new.k IN ('auth.sessionVersion', 'enc.fingerprint', 'drive.id') BEGIN ${BUMP} END;

    -- Thumbnails travel to Telegram in packs of their own (each uploaded once),
    -- so the frequent index backups stay small. A thumbnail not yet in a pack
    -- is a pending change; filling one back in from its pack is not.
    CREATE TABLE thumb_packs (
      id          INTEGER PRIMARY KEY,
      ref         TEXT NOT NULL,
      size        INTEGER NOT NULL,
      count       INTEGER NOT NULL,
      created_at  INTEGER NOT NULL
    );
    ALTER TABLE thumbs ADD COLUMN pack INTEGER REFERENCES thumb_packs(id);
    CREATE INDEX thumbs_pack ON thumbs(pack);
    CREATE TRIGGER rev_thumbs_ins AFTER INSERT ON thumbs BEGIN ${BUMP} END;
    CREATE TRIGGER rev_thumbs_del AFTER DELETE ON thumbs BEGIN ${BUMP} END;
    CREATE TRIGGER rev_thumbs_upd AFTER UPDATE ON thumbs WHEN new.pack IS NULL BEGIN ${BUMP} END;
  `,
  ],
};

/** The original v1 schema (exported so migration tests can build a v1 database). */
export const MIGRATIONS_V1: Record<number, string> = {
  1: /* sql */ `
    CREATE TABLE blobs (
      id          TEXT PRIMARY KEY,
      size        INTEGER NOT NULL,
      hash        TEXT,
      part_size   INTEGER NOT NULL,
      part_count  INTEGER NOT NULL,
      driver      TEXT NOT NULL,
      enc_iv      BLOB,
      created_at  INTEGER NOT NULL
    ) WITHOUT ROWID;
    CREATE INDEX blobs_hash ON blobs(hash, size) WHERE hash IS NOT NULL;

    CREATE TABLE blob_parts (
      blob_id TEXT NOT NULL REFERENCES blobs(id) ON DELETE CASCADE,
      idx     INTEGER NOT NULL,
      size    INTEGER NOT NULL,
      ref     TEXT NOT NULL,
      PRIMARY KEY (blob_id, idx)
    ) WITHOUT ROWID;

    CREATE TABLE nodes (
      rid         INTEGER PRIMARY KEY,
      id          TEXT NOT NULL UNIQUE,
      parent_id   TEXT REFERENCES nodes(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL CHECK (kind IN ('folder', 'file')),
      name        TEXT NOT NULL,
      size        INTEGER NOT NULL DEFAULT 0,
      mime        TEXT,
      blob_id     TEXT REFERENCES blobs(id),
      starred     INTEGER NOT NULL DEFAULT 0,
      trashed_at  INTEGER,
      in_trash    INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      touched_at  INTEGER NOT NULL
    );
    CREATE INDEX nodes_children ON nodes(parent_id, in_trash, kind, name COLLATE NOCASE);
    CREATE INDEX nodes_blob     ON nodes(blob_id) WHERE blob_id IS NOT NULL;
    CREATE INDEX nodes_recent   ON nodes(kind, in_trash, touched_at DESC);
    CREATE INDEX nodes_starred  ON nodes(starred) WHERE starred = 1;
    CREATE INDEX nodes_trashed  ON nodes(trashed_at) WHERE trashed_at IS NOT NULL;

    CREATE VIRTUAL TABLE nodes_fts USING fts5(
      name, content = 'nodes', content_rowid = 'rid', tokenize = 'trigram remove_diacritics 1'
    );
    CREATE TRIGGER nodes_fts_ai AFTER INSERT ON nodes BEGIN
      INSERT INTO nodes_fts(rowid, name) VALUES (new.rid, new.name);
    END;
    CREATE TRIGGER nodes_fts_ad AFTER DELETE ON nodes BEGIN
      INSERT INTO nodes_fts(nodes_fts, rowid, name) VALUES ('delete', old.rid, old.name);
    END;
    CREATE TRIGGER nodes_fts_au AFTER UPDATE OF name ON nodes BEGIN
      INSERT INTO nodes_fts(nodes_fts, rowid, name) VALUES ('delete', old.rid, old.name);
      INSERT INTO nodes_fts(rowid, name) VALUES (new.rid, new.name);
    END;

    CREATE TABLE thumbs (
      blob_id TEXT PRIMARY KEY REFERENCES blobs(id) ON DELETE CASCADE,
      mime    TEXT NOT NULL,
      data    BLOB NOT NULL,
      width   INTEGER,
      height  INTEGER
    ) WITHOUT ROWID;

    CREATE TABLE shares (
      id          TEXT PRIMARY KEY,
      node_id     TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      created_at  INTEGER NOT NULL,
      expires_at  INTEGER,
      downloads   INTEGER NOT NULL DEFAULT 0
    ) WITHOUT ROWID;
    CREATE INDEX shares_node ON shares(node_id);

    CREATE TABLE uploads (
      id          TEXT PRIMARY KEY,
      state       TEXT NOT NULL,
      updated_at  INTEGER NOT NULL
    ) WITHOUT ROWID;

    CREATE TABLE gc_queue (
      id        INTEGER PRIMARY KEY,
      driver    TEXT NOT NULL,
      blob_id   TEXT NOT NULL,
      ref       TEXT NOT NULL,
      attempts  INTEGER NOT NULL DEFAULT 0,
      next_at   INTEGER NOT NULL
    );

    CREATE TABLE kv (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    ) WITHOUT ROWID;
  `,
};

function open(): DB {
  const cfg = config();
  const db = new Database(cfg.dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("temp_store = MEMORY");
  // Page cache and memory-mapped reads (64 MiB / 256 MiB; less on small hosts).
  db.pragma(`cache_size = -${Math.round(cfg.sqlite.cacheBytes / 1024)}`);
  db.pragma(`mmap_size = ${cfg.sqlite.mmapBytes}`);
  db.pragma("busy_timeout = 5000");
  migrate(db);

  const now = Date.now();
  db.prepare(
    `INSERT OR IGNORE INTO nodes (id, parent_id, kind, name, created_at, updated_at, touched_at)
     VALUES ('root', NULL, 'folder', 'My files', ?, ?, ?)`,
  ).run(now, now, now);
  // Which drive this index belongs to: carried by every backup, so a server
  // never mistakes another drive's backup for its own.
  db.prepare("INSERT OR IGNORE INTO kv (k, v) VALUES ('drive.id', ?)").run(crypto.randomBytes(9).toString("base64url"));

  // Opportunistic maintenance: keeps the query planner's statistics fresh.
  db.pragma("optimize = 0x10002");
  return db;
}

interface DbState {
  db: DB;
  statements: Map<string, Database.Statement>;
}
const g = globalThis as unknown as {
  __tsDb?: DbState;
  /** Set once a missing database may be created, or a restored one is in place. */
  __tsDbReady?: boolean;
  /** Why the database isn't available yet (shown while a restore runs). */
  __tsDbWaitMessage?: string;
  /** Run once, right after the database is next opened (e.g. sessions handed over by a restore). */
  __tsDbOnOpen?: ((db: DB) => void)[];
};

/**
 * Hosts with throwaway disks (free tiers) start with no database: it has to
 * come back from the backup in Telegram first. Until the restore has decided
 * (see storage/recovery.ts), opening one would create an empty drive, so
 * every caller gets a "come back in a moment" instead.
 */
function mayOpen(): void {
  if (g.__tsDbReady) return;
  const cfg = config();
  if (!cfg.durability.autoRestore || cfg.driver === "local" || fs.existsSync(cfg.dbPath)) {
    g.__tsDbReady = true;
    return;
  }
  throw new RestoringError(g.__tsDbWaitMessage ?? "Restoring your drive from Telegram…");
}

/** Lets the database open (recovery calls this when the file is in place or the drive is new). */
export function allowDatabase(onOpen?: (db: DB) => void) {
  if (onOpen) (g.__tsDbOnOpen ??= []).push(onOpen);
  g.__tsDbReady = true;
}

export function setDatabaseWaitMessage(message: string) {
  g.__tsDbWaitMessage = message;
}

export function databaseOpen() {
  return Boolean(g.__tsDb);
}

/**
 * Swaps in another index (a newer backup this server adopted). The caller
 * makes sure nothing is mid-flight; prepared statements and cached blob
 * metadata belong to the old file, so they go with it.
 */
export function replaceDatabase(file: string, onOpen?: (db: DB) => void) {
  const dbPath = config().dbPath;
  if (g.__tsDb) {
    g.__tsDb.statements.clear();
    g.__tsDb.db.close();
    g.__tsDb = undefined;
  }
  for (const ext of ["-wal", "-shm"]) fs.rmSync(dbPath + ext, { force: true });
  fs.renameSync(file, dbPath);
  schemaChecked = false;
  allowDatabase(onOpen);
}

/** Applies pending migrations; returns how many ran. */
function migrate(db: DB): number {
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current > SCHEMA_VERSION) {
    throw new Error(`Database schema v${current} is newer than this build (v${SCHEMA_VERSION}) — refusing to downgrade`);
  }
  for (let v = current + 1; v <= SCHEMA_VERSION; v++) {
    // Each version applies atomically: a crash mid-migration leaves the previous version intact.
    db.transaction(() => {
      const steps = v === 1 ? [MIGRATIONS_V1[1]] : MIGRATIONS[v];
      for (const step of steps) {
        if (typeof step === "string") db.exec(step);
        else step(db);
      }
      db.pragma(`user_version = ${v}`);
    })();
  }
  return Math.max(0, SCHEMA_VERSION - current);
}

// Once per evaluation of this module: in development a hot reload brings new
// code (and maybe a new schema) to a connection that was opened by the old one.
let schemaChecked = false;

export function db(): DB {
  if (!g.__tsDb) {
    mayOpen();
    const opened = open();
    g.__tsDb = { db: opened, statements: new Map() };
    for (const fn of g.__tsDbOnOpen?.splice(0) ?? []) fn(opened);
  } else if (!schemaChecked && migrate(g.__tsDb.db) > 0) {
    // Cached statements may point at tables a migration rebuilt.
    g.__tsDb.statements.clear();
    g.__tsDb.db.prepare("UPDATE nodes SET name = 'My files' WHERE id = 'root' AND name IN ('Hangar', 'My Drive')").run();
  }
  schemaChecked = true;
  return g.__tsDb.db;
}

/** Prepared-statement cache: each SQL string is compiled exactly once per process. */
export function sql<BindParams extends unknown[] = unknown[], Row = unknown>(text: string) {
  const database = db();
  const cache = g.__tsDb!.statements;
  let s = cache.get(text);
  if (!s) {
    s = database.prepare(text);
    cache.set(text, s);
  } else if (s.reader) {
    // `.pluck()` changes the cached statement itself: hand out a clean one every
    // time, so a call site that plucks can't change what another one receives.
    s.pluck(false);
  }
  return s as Database.Statement<BindParams, Row>;
}

export function tx<T>(fn: () => T): T {
  return db().transaction(fn)();
}

export const kv = {
  get(k: string): string | undefined {
    return (sql("SELECT v FROM kv WHERE k = ?").get(k) as { v: string } | undefined)?.v;
  },
  set(k: string, v: string) {
    sql("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
  },
  delete(k: string) {
    sql("DELETE FROM kv WHERE k = ?").run(k);
  },
};
