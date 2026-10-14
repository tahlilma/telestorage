import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// A simulated channel that lives outside DATA_DIR, as a real one lives outside the server.
const SIM_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "hangar-test-simchan-"));
process.env.STORAGE_DRIVER = "sim";
process.env.SIM_DIR = SIM_DIR;
process.env.SIM_LATENCY_MS = "0";
process.env.SIM_JITTER_MS = "0";
process.env.ENCRYPTION_KEY = "durability suite passphrase";
// Backups on (the shared setup turns them off), but only when a test asks.
process.env.BACKUP_INTERVAL_HOURS = "6";
process.env.BACKUP_DELAY_SEC = "3600";
process.env.BACKUP_MAX_DELAY_SEC = "3600";

type Fmt = typeof import("@/server/storage/backup-format");
type Backup = typeof import("@/server/storage/backup");
type Runtime = import("@/server/storage").Runtime;
let fmt: Fmt;
let backup: Backup;
let rt: Runtime;
let sql: typeof import("@/server/db").sql;
let kv: typeof import("@/server/db").kv;
let shutdown: () => Promise<void>;

beforeAll(async () => {
  fmt = await import("@/server/storage/backup-format");
  const s = await import("@/server/storage");
  rt = await s.storage();
  shutdown = s.shutdownStorage;
  backup = await import("@/server/storage/backup");
  ({ sql, kv } = await import("@/server/db"));
});

afterAll(async () => {
  await shutdown?.();
  fs.rmSync(SIM_DIR, { recursive: true, force: true });
});

describe("backup formats", () => {
  it("round-trips captions, and drops the session rather than exceed Telegram's caption limit", () => {
    const c = { at: 1, drive: "d1", br: "b1", par: 7, rev: 42, rel: false, enc: true, s0: "x".repeat(400) };
    const parsed = fmt.parseBackupCaption(fmt.backupCaption(c));
    expect(parsed).toEqual({ v: 3, ...c });
    const long = fmt.backupCaption({ ...c, s0: "y".repeat(2000) });
    expect(long.length).toBeLessThanOrEqual(1024);
    expect(fmt.parseBackupCaption(long)?.s0).toBeNull();
    expect(fmt.parseBackupCaption(fmt.releasedCaption(fmt.backupCaption(c))!)?.rel).toBe(true);
  });

  it("reads older backup captions and ignores everything else", () => {
    expect(fmt.parseBackupCaption('#telestorage_backup {"v":2,"at":5}')).toMatchObject({ v: 2, at: 5, drive: null, rel: false });
    expect(fmt.parseBackupCaption("#telestorage_backup")).toMatchObject({ v: 1, drive: null });
    expect(fmt.parseBackupCaption('#telestorage {"b":"x"}')).toBeNull();
    expect(fmt.parseBackupCaption("holiday photos")).toBeNull();
  });

  it("seals bot sessions so only the bot's own token opens them", () => {
    const session = `1${crypto.randomBytes(263).toString("base64")}`;
    const sealed = fmt.sealSession("123:token-a", session);
    expect(fmt.openSession("123:token-a", sealed)).toBe(session);
    expect(fmt.openSession("123:token-b", sealed)).toBeNull();
    expect(fmt.openSession("123:token-a", fmt.sealSession("123:token-a", "plain"))).toBe("plain");
    expect(sealed.length).toBeLessThan(420); // fits in a caption next to the rest
  });

  it("packs thumbnails byte-exact", () => {
    const items = [
      { blobId: "a", mime: "image/webp", width: 480, height: 320, data: crypto.randomBytes(1234) },
      { blobId: "b", mime: "image/jpeg", width: null, height: null, data: crypto.randomBytes(1) },
    ];
    const back = fmt.decodeThumbPack(fmt.encodeThumbPack(items));
    expect(back.map((t) => ({ ...t, data: Buffer.from(t.data) }))).toEqual(items);
    expect(() => fmt.decodeThumbPack(fmt.encodeThumbPack(items).subarray(0, 50))).toThrow();
  });

  it("decides whose pinned backup may be replaced", () => {
    const me = { drive: "D", branch: "mine", base: { m: 10, br: "old", rev: 1 } };
    const cap = (o: Partial<import("@/server/storage/backup-format").BackupCaption>) => ({ v: 3, at: 1, drive: "D", br: "x", par: null, rev: 1, rel: false, enc: false, s0: null, ...o });
    expect(fmt.judgePinned(null, me).kind).toBe("free");
    expect(fmt.judgePinned({ m: 5, caption: null }, me).kind).toBe("free");
    expect(fmt.judgePinned({ m: 5, caption: cap({ drive: null, v: 2 }) }, me).kind).toBe("free");
    expect(fmt.judgePinned({ m: 5, caption: cap({ drive: "OTHER" }) }, me).kind).toBe("foreign");
    expect(fmt.judgePinned({ m: 99, caption: cap({ br: "mine" }) }, me).kind).toBe("ours");
    expect(fmt.judgePinned({ m: 10, caption: cap({ br: "old" }) }, me).kind).toBe("ours");
    expect(fmt.judgePinned({ m: 11, caption: cap({ br: "theirs", par: 10 }) }, me).kind).toBe("ahead");
    expect(fmt.judgePinned({ m: 11, caption: cap({ br: "theirs", par: 3 }) }, me).kind).toBe("diverged");
  });
});

describe("change counter", () => {
  it("counts what a backup must carry, not bookkeeping", () => {
    const rev = () => backup.currentRev();
    const now = Date.now();
    let r = rev();
    sql("INSERT INTO nodes (id, parent_id, kind, name, created_at, updated_at, touched_at) VALUES ('cc1', 'root', 'folder', 'Counted', ?, ?, ?)").run(now, now, now);
    expect(rev()).toBeGreaterThan(r);

    r = rev();
    sql("UPDATE nodes SET touched_at = ? WHERE id = 'cc1'").run(now + 1); // "recent" bookkeeping
    expect(rev()).toBe(r);
    sql("UPDATE nodes SET name = 'Renamed' WHERE id = 'cc1'").run();
    expect(rev()).toBe(r + 1);

    r = rev();
    sql("INSERT INTO blobs (id, size, part_size, part_count, driver, created_at) VALUES ('ccb', 1, 1, 0, 'sim', ?)").run(now);
    expect(rev()).toBe(r + 1);
    r = rev();
    sql("UPDATE blobs SET verified_at = ?, corrupt_at = NULL WHERE id = 'ccb'").run(now); // the scrubber
    expect(rev()).toBe(r);

    r = rev();
    kv.set("backup.something", "x");
    kv.set("fsck.last", "{}");
    expect(rev()).toBe(r);
    kv.set("auth.sessionVersion", "7"); // "sign out everywhere" must survive a restore
    expect(rev()).toBe(r + 1);

    r = rev();
    sql("INSERT INTO thumbs (blob_id, mime, data) VALUES ('ccb', 'image/webp', ?)").run(Buffer.from("thumb"));
    expect(rev()).toBe(r + 1);
    sql("DELETE FROM nodes WHERE id = 'cc1'").run();
    sql("DELETE FROM blobs WHERE id = 'ccb'").run();
  });
});

describe("backups in the channel", () => {
  it("stores, pins and restores the index, with thumbnails in a pack of their own", async () => {
    const now = Date.now();
    sql("INSERT INTO nodes (id, parent_id, kind, name, created_at, updated_at, touched_at) VALUES ('bk1', 'root', 'folder', 'Holidays', ?, ?, ?)").run(now, now, now);
    sql("INSERT INTO blobs (id, size, part_size, part_count, driver, created_at) VALUES ('tb1', 1, 1, 0, 'sim', ?)").run(now);
    const thumb = crypto.randomBytes(20_000);
    sql("INSERT INTO thumbs (blob_id, mime, data, width, height) VALUES ('tb1', 'image/webp', ?, 480, 360)").run(thumb);
    kv.set("tg.session.999", "not-a-real-session");

    expect(backup.isDirty()).toBe(true);
    const r = await backup.runBackup(rt, { force: true });
    expect(r.status).toBe("stored");
    expect(backup.isDirty()).toBe(false);

    // The thumbnail went into a pack; the index only says which.
    const packed = sql("SELECT pack FROM thumbs WHERE blob_id = 'tb1'").pluck().get() as number;
    expect(packed).toBeGreaterThan(0);

    const pinned = await backup.pinnedBackup(rt);
    expect(pinned?.caption).toMatchObject({ v: 3, drive: kv.get("drive.id"), br: kv.get("drive.branch"), enc: true, rel: false });

    // What a server on an empty disk would make of it.
    const { materializeBackup } = await import("@/server/storage/recovery");
    const raw = fs.readFileSync(path.join(SIM_DIR, `msg-${pinned!.post.id}`));
    expect(raw.subarray(0, 4).toString("latin1")).toBe("TSB1"); // sealed with ENCRYPTION_KEY
    const m = materializeBackup(raw, pinned!.post, pinned!.caption, { mode: "boot" });
    const copy = new Database(m.file, { readonly: true });
    try {
      expect(copy.prepare("SELECT name FROM nodes WHERE id = 'bk1'").pluck().get()).toBe("Holidays");
      expect(copy.prepare("SELECT length(data) FROM thumbs WHERE blob_id = 'tb1'").pluck().get()).toBe(0);
      expect(copy.prepare("SELECT pack FROM thumbs WHERE blob_id = 'tb1'").pluck().get()).toBe(packed);
      const kvOf = (k: string) => copy.prepare("SELECT v FROM kv WHERE k = ?").pluck().get(k);
      expect(kvOf("drive.branch")).not.toBe(kv.get("drive.branch")); // a line of history of its own
      expect(JSON.parse(kvOf("backup.base") as string).m).toBe(pinned!.post.id);
      expect(Number(kvOf("backup.rev"))).toBe(m.rev);
      expect(kvOf("tg.session.999")).toBeUndefined(); // no token for it here: never leaves sealed
      expect(copy.prepare("SELECT COUNT(*) FROM kv WHERE k LIKE 'tg.vault.%'").pluck().get()).toBe(0);
    } finally {
      copy.close();
      fs.rmSync(m.file, { force: true });
    }

    // Thumbnail data comes back from its pack on demand.
    sql("UPDATE thumbs SET data = x'' WHERE blob_id = 'tb1'").run();
    expect(backup.isDirty()).toBe(false); // emptying a packed thumbnail isn't a change
    await backup.loadThumbPack(rt, packed);
    expect(Buffer.compare(sql("SELECT data FROM thumbs WHERE blob_id = 'tb1'").pluck().get() as Buffer, thumb)).toBe(0);
  });

  it("doesn't back up when nothing changed, and marks the backup final on hand-over", async () => {
    expect((await backup.runBackup(rt)).status).toBe("clean");
    const before = await backup.pinnedBackup(rt);
    expect((await backup.releaseDrive(rt)).status).toBe("released");
    const after = await backup.pinnedBackup(rt);
    expect(after?.post.id).toBe(before?.post.id); // marked in place: no new post
    expect(after?.caption.rel).toBe(true);
  });

  it("never pins over another drive's backup", async () => {
    // Someone else's drive pins its backup in this channel.
    const foreign = await backup.storeBuffer(rt, Buffer.from("x"), "other.db.gz", fmt.backupCaption({ at: Date.now(), drive: "OTHER", br: "z", par: null, rev: 1, rel: false, enc: false, s0: null }));
    await rt.driver.pin!(foreign);
    sql("UPDATE nodes SET name = 'Holidays 2026' WHERE id = 'bk1'").run();
    const r = await backup.runBackup(rt);
    expect(r.status).toBe("stored"); // this drive's changes are safe in the channel…
    expect((await backup.pinnedBackup(rt))?.caption.drive).toBe("OTHER"); // …but the pin stays
    expect(backup.backupStatus().notice?.kind).toBe("foreign");
    expect(backup.isDirty()).toBe(false);
  });
});
