// Disaster recovery: rebuilds the metadata database from the backup pinned in
// your Telegram channel. Your files never left Telegram — this restores the
// index that maps names and folders to them.
//
//   npm run restore            (refuses to overwrite an existing database)
//   npm run restore -- --force (moves the current database aside first)
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import zlib from "node:zlib";

const require = createRequire(import.meta.url);
const { Api, TelegramClient, Logger, sessions } = require("telegram");
const bigInt = require("big-integer");

if (fs.existsSync(".env")) process.loadEnvFile(".env");
const force = process.argv.includes("--force");
const apiId = Number(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;
const token = (process.env.TG_BOT_TOKENS ?? "").split(/[\s,]+/).filter(Boolean)[0];
const channelId = (process.env.TG_CHANNEL_ID ?? "").replace(/^-100/, "");
const dataDir = path.resolve(process.env.DATA_DIR || "data");
const dbPath = path.join(dataDir, "telestorage.db");

if (!apiId || !apiHash || !token || !channelId) {
  console.error("TG_API_ID, TG_API_HASH, TG_BOT_TOKENS and TG_CHANNEL_ID must be set.");
  process.exit(1);
}
if (fs.existsSync(dbPath) && !force) {
  console.error(`${dbPath} already exists. Re-run with --force to replace it (the current file is kept as .bak).`);
  process.exit(1);
}

/** Must match src/server/config.ts parseEncryptionKey(). */
function encryptionKey() {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) return null;
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  return crypto.scryptSync(raw, "telestorage/v1/encryption", 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

const client = new TelegramClient(new sessions.StringSession(""), apiId, apiHash, { connectionRetries: 3, baseLogger: new Logger("error") });
await client.start({ botAuthToken: token });

const { chats } = await client.invoke(
  new Api.channels.GetChannels({ id: [new Api.InputChannel({ channelId: bigInt(channelId), accessHash: bigInt.zero })] }),
);
const channel = new Api.InputChannel({ channelId: chats[0].id, accessHash: chats[0].accessHash });
const full = await client.invoke(new Api.channels.GetFullChannel({ channel }));
const pinned = full.fullChat.pinnedMsgId;
if (!pinned) {
  console.error("No pinned message in the channel — no backup to restore. (Backups need the bots' \"Pin messages\" right.)");
  process.exit(1);
}
const { messages } = await client.invoke(new Api.channels.GetMessages({ channel, id: [new Api.InputMessageID({ id: pinned })] }));
const msg = messages[0];
if (!msg?.message?.startsWith("#telestorage_backup")) {
  console.error("The pinned message is not a Telestorage backup.");
  process.exit(1);
}
const name = msg.media?.document?.attributes?.find((a) => a.fileName)?.fileName ?? "backup";
console.log(`Downloading ${name} (${msg.media.document.size} bytes)…`);
let data = await client.downloadMedia(msg);

const open = (key, sealed) => {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, sealed.subarray(4, 16));
  decipher.setAuthTag(sealed.subarray(16, 32));
  return Buffer.concat([decipher.update(sealed.subarray(32)), decipher.final()]);
};
if (data.subarray(0, 4).toString("latin1") === "TSB1") {
  const key = encryptionKey();
  if (!key) {
    console.error("This backup is encrypted — set the same ENCRYPTION_KEY you used before.");
    process.exit(1);
  }
  data = open(key, data);
}
const bytes = zlib.gunzipSync(data);

fs.mkdirSync(dataDir, { recursive: true });
if (fs.existsSync(dbPath)) {
  const bak = `${dbPath}.${Date.now()}.bak`;
  fs.renameSync(dbPath, bak);
  for (const ext of ["-wal", "-shm"]) if (fs.existsSync(dbPath + ext)) fs.rmSync(dbPath + ext);
  console.log(`Existing database moved to ${bak}`);
}
fs.writeFileSync(dbPath, bytes);

// Same hand-over the server does when it restores by itself (src/server/storage/recovery.ts):
// a line of history of its own, the backup it continues from, and the bots' sessions
// unsealed with their tokens so they needn't log in again.
let caption = {};
try {
  caption = JSON.parse(msg.message.slice("#telestorage_backup".length).trim() || "{}");
} catch {
  /* older caption */
}
const Database = require("better-sqlite3");
const d = new Database(dbPath);
const get = (k) => d.prepare("SELECT v FROM kv WHERE k = ?").pluck().get(k) ?? null;
const put = d.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v");
const hasRev = d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'drive_rev'").get();
const rev = hasRev ? d.prepare("SELECT rev FROM drive_rev WHERE id = 1").pluck().get() : null;
let sessions = 0;
d.transaction(() => {
  put.run("drive.branch", crypto.randomBytes(6).toString("base64url"));
  put.run("backup.base", JSON.stringify({ m: pinned, br: caption.br ?? null, rev: caption.rev ?? rev }));
  put.run("backup.rev", String(rev ?? -1));
  put.run("restore.last", JSON.stringify({ at: Date.now(), messageId: pinned, backupAt: caption.at ?? null, mode: "manual" }));
  for (const t of (process.env.TG_BOT_TOKENS ?? "").split(/[\s,]+/).filter(Boolean)) {
    const id = t.split(":")[0];
    const sealed = get(`tg.vault.${id}`);
    if (!sealed) continue;
    try {
      const key = Buffer.from(crypto.hkdfSync("sha256", t, Buffer.alloc(0), "telestorage/bot-session/v1", 32));
      const buf = open(key, Buffer.concat([Buffer.from("TSB1"), Buffer.from(sealed, "base64url")]));
      put.run(`tg.session.${id}`, buf[0] === 1 ? `1${buf.subarray(1).toString("base64")}` : buf.subarray(1).toString("utf8"));
      sessions++;
    } catch {
      /* token changed: that bot logs in again */
    }
  }
  d.prepare("DELETE FROM kv WHERE k LIKE 'tg.vault.%' OR k IN ('backup.error', 'backup.notice', 'backup.allowReplace')").run();
})();
d.close();
console.log(`✓ Restored ${(bytes.length / 1024).toFixed(0)} KiB index to ${dbPath}.`);
console.log(`  Start the server${sessions ? "" : " — bots will log in again automatically"}. Thumbnails come back from Telegram as you browse.`);
await client.destroy();
process.exit(0);
