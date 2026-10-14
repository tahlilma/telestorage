// Starts the drive over from nothing.
//
//   npm run reset                    forget every file (the index), keep your sign-in
//   npm run reset -- --telegram      …and delete this drive's posts from the channel too
//   npm run reset -- --everything    delete the whole data folder (also the sign-in secret)
//   add --yes to skip the question
//
// Stop the server first. Only posts this drive made (files, unfinished uploads,
// backups) are deleted from Telegram; anything else in the channel is left alone.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const args = new Set(process.argv.slice(2));
const wipeTelegram = args.has("--telegram");
const everything = args.has("--everything");
const yes = args.has("--yes") || args.has("-y");

if (fs.existsSync(".env")) process.loadEnvFile(".env");
const dataDir = path.resolve(process.env.DATA_DIR || "data");
const dbPath = path.join(dataDir, "telestorage.db");
const port = Number(process.env.PORT || 3000);

// 1. The server must be down: it holds the database open and would recreate it.
const listening = await new Promise((resolve) => {
  const s = net.connect({ port, host: "127.0.0.1" });
  s.once("connect", () => (s.destroy(), resolve(true)));
  s.once("error", () => resolve(false));
  s.setTimeout(1000, () => (s.destroy(), resolve(false)));
});
if (listening) {
  console.error(`Something is running on port ${port}. Stop the server (Ctrl+C in its terminal, or \`docker compose stop\`) and run this again.`);
  process.exit(1);
}

// 2. What's there.
let stats = null;
let messageIds = [];
if (fs.existsSync(dbPath)) {
  const Database = require("better-sqlite3");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const one = (q) => db.prepare(q).pluck().get();
  const has = (t) => Boolean(one(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '${t}'`));
  stats = {
    files: has("nodes") ? one("SELECT COUNT(*) FROM nodes WHERE kind = 'file'") : 0,
    bytes: has("nodes") ? one("SELECT COALESCE(SUM(size), 0) FROM nodes WHERE kind = 'file'") : 0,
  };
  if (wipeTelegram) {
    const ids = new Set();
    const addRef = (ref) => {
      try {
        const m = JSON.parse(ref)?.m;
        if (Number.isInteger(m)) ids.add(m);
      } catch {
        /* not a Telegram reference */
      }
    };
    if (has("blob_parts")) for (const r of db.prepare("SELECT ref FROM blob_parts").pluck().all()) addRef(r);
    if (has("upload_parts")) for (const r of db.prepare("SELECT ref FROM upload_parts WHERE ref IS NOT NULL").pluck().all()) addRef(r);
    if (has("gc_queue")) for (const r of db.prepare("SELECT ref FROM gc_queue").pluck().all()) addRef(r);
    if (has("thumb_packs")) for (const r of db.prepare("SELECT ref FROM thumb_packs").pluck().all()) addRef(r);
    const history = has("kv") ? one("SELECT v FROM kv WHERE k = 'backup.history'") : null;
    for (const b of history ? JSON.parse(history) : []) {
      if (b.ref) addRef(b.ref);
      else if (Number.isInteger(b.msgId)) ids.add(b.msgId);
    }
    messageIds = [...ids].sort((a, b) => a - b);
  }
  db.close();
}

const gib = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
console.log(`Data folder: ${dataDir}`);
if (stats) console.log(`The index knows ${stats.files.toLocaleString()} file(s), ${gib(stats.bytes)}.`);
else console.log("No database there — nothing to forget.");
console.log("\nThis will:");
console.log(everything ? "  • delete the whole data folder (database, cache, local files, sign-in secret)" : "  • delete the database, the block cache and any locally stored files");
if (wipeTelegram) console.log(`  • delete ${messageIds.length.toLocaleString()} post(s) this drive made in the Telegram channel`);
else if (process.env.TG_CHANNEL_ID) console.log("  • leave the posts in your Telegram channel (add --telegram to delete them, or just make a new channel)");
console.log("Your .env stays as it is.\n");

if (!yes) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('Type "reset" to go ahead: ')).trim();
  rl.close();
  if (answer !== "reset") {
    console.log("Nothing changed.");
    process.exit(0);
  }
}

// 3. Telegram first: once the database is gone, nothing knows which posts were ours.
if (wipeTelegram && messageIds.length) {
  const apiId = Number(process.env.TG_API_ID);
  const apiHash = process.env.TG_API_HASH;
  const token = (process.env.TG_BOT_TOKENS ?? "").split(/[\s,]+/).filter(Boolean)[0];
  const channelId = (process.env.TG_CHANNEL_ID ?? "").replace(/^-100/, "");
  if (!apiId || !apiHash || !token || !channelId) {
    console.error("--telegram needs TG_API_ID, TG_API_HASH, TG_BOT_TOKENS and TG_CHANNEL_ID in .env. Nothing was deleted.");
    process.exit(1);
  }
  const { Api, TelegramClient, Logger, sessions } = require("telegram");
  const bigInt = require("big-integer");
  const client = new TelegramClient(new sessions.StringSession(""), apiId, apiHash, { connectionRetries: 3, baseLogger: new Logger("error") });
  await client.start({ botAuthToken: token });
  const res = await client.invoke(new Api.channels.GetChannels({ id: [new Api.InputChannel({ channelId: bigInt(channelId), accessHash: bigInt.zero })] }));
  const chat = res.chats[0];
  const channel = new Api.InputChannel({ channelId: chat.id, accessHash: chat.accessHash });
  let done = 0;
  for (let i = 0; i < messageIds.length; ) {
    const batch = messageIds.slice(i, i + 100);
    try {
      await client.invoke(new Api.channels.DeleteMessages({ channel, id: batch }));
      i += batch.length;
      done += batch.length;
      process.stdout.write(`\r  deleted ${done.toLocaleString()} / ${messageIds.length.toLocaleString()} posts`);
    } catch (e) {
      const wait = /FLOOD_WAIT_(\d+)/.exec(e.errorMessage ?? e.message)?.[1];
      if (!wait) {
        console.error(`\nTelegram refused: ${e.errorMessage ?? e.message}. Nothing on disk was deleted; fix that and run again.`);
        await client.destroy();
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, (Number(wait) + 1) * 1000));
    }
  }
  console.log("");
  await client.destroy();
}

// 4. Disk.
const rm = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
if (everything) {
  rm(dataDir);
} else {
  for (const name of ["telestorage.db", "telestorage.db-wal", "telestorage.db-shm", "cache", "blobs", "backups", "sim"]) rm(path.join(dataDir, name));
  for (const f of fs.existsSync(dataDir) ? fs.readdirSync(dataDir) : []) if (/^(backup|restore)-[\w-]+\.db$/.test(f)) rm(path.join(dataDir, f));
}
// A server that finds no index restores the backup pinned in Telegram (so a
// host that wipes its disk doesn't lose the drive). This marker tells it that
// the empty drive is on purpose — and that its first backup may replace that pin.
fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, "fresh-start.json"), JSON.stringify({ at: Date.now(), reason: "npm run reset" }));
console.log("Done. Start the server and you'll have an empty drive.");
