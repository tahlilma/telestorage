import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { DriveNode, Share } from "@/lib/types";
import { Client, key, randomBytes, sleep } from "./client";

/**
 * Free hosts wipe the disk on every restart. These servers each start on an
 * empty data folder and share one simulated Telegram channel, the way
 * successive instances of a free-tier deployment share the real one: the
 * drive must survive every restart, hand-over and overlap intact.
 */

const SIM_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "telestorage-e2e-channel-"));
const PASSWORD = "durability-pass";
const dist = process.env.NEXT_DIST_DIR || ".next";
const dirs: string[] = [SIM_DIR];

interface Server {
  name: string;
  url: string;
  data: string;
  child: ChildProcess;
  log: string[];
}
const running = new Set<Server>();

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });

async function start(name: string, extra: Record<string, string> = {}, data?: string): Promise<Server> {
  const port = await freePort();
  const dataDir = data ?? fs.mkdtempSync(path.join(os.tmpdir(), `telestorage-e2e-${name}-`));
  dirs.push(dataDir);
  const env = {
    ...process.env,
    NODE_ENV: "production",
    DATA_DIR: dataDir,
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    STORAGE_DRIVER: "sim",
    SIM_DIR,
    SIM_BOTS: "2",
    SIM_LATENCY_MS: "5",
    SIM_JITTER_MS: "5",
    TG_API_ID: "",
    TG_API_HASH: "",
    TG_BOT_TOKENS: "",
    TG_CHANNEL_ID: "",
    AUTH_PASSWORD: PASSWORD,
    AUTH_TOTP_SECRET: "",
    // Same as a Telegram deployment, where it's derived from the bot tokens: sign-ins survive a restart.
    AUTH_SECRET: "durability-suite-session-secret",
    PUBLIC_URL: "",
    ENCRYPTION_KEY: "durability-suite-key",
    TG_PART_SIZE_MB: "2",
    SCRUB_MBPS: "0",
    BACKUP_INTERVAL_HOURS: "6",
    BACKUP_DELAY_SEC: "1",
    BACKUP_MAX_DELAY_SEC: "4",
    HANDOVER_WAIT_SEC: "2",
    NEXT_DIST_DIR: dist,
    NEXT_TELEMETRY_DISABLED: "1",
    ...extra,
  } as NodeJS.ProcessEnv;
  const child = spawn(process.execPath, ["scripts/start.mjs"], { env, stdio: ["ignore", "pipe", "pipe"] });
  const server: Server = { name, url: `http://127.0.0.1:${port}`, data: dataDir, child, log: [] };
  child.stdout!.on("data", (d: Buffer) => server.log.push(String(d)));
  child.stderr!.on("data", (d: Buffer) => server.log.push(String(d)));
  running.add(server);
  for (let i = 0; ; i++) {
    if (child.exitCode !== null) throw new Error(`${name} exited early:\n${server.log.join("")}`);
    try {
      await fetch(`${server.url}/api/health`);
      return server;
    } catch {
      /* not listening yet */
    }
    if (i > 240) throw new Error(`${name} never started:\n${server.log.join("")}`);
    await sleep(250);
  }
}

type Health = { ready?: boolean; restoring?: boolean; phase?: string };
const health = async (s: Server) => (await (await fetch(`${s.url}/api/health`)).json()) as Health;

async function ready(s: Server, ms = 60_000, seen?: Set<string>) {
  const t0 = Date.now();
  for (;;) {
    const h = await health(s).catch(() => ({}) as Health);
    if (h.phase) seen?.add(h.phase);
    if (h.ready) return Date.now() - t0;
    if (Date.now() - t0 > ms) throw new Error(`${s.name} not ready after ${ms} ms: ${JSON.stringify(h)}\n${s.log.join("")}`);
    await sleep(200);
  }
}

/** Abrupt death (OOM, a host pulling the plug): no hand-over. */
async function kill(s: Server) {
  running.delete(s);
  s.child.kill("SIGKILL");
  if (s.child.exitCode === null) await new Promise((r) => s.child.once("exit", r));
}

type Backup = { pending: boolean; lastAt: number | null; notice: { kind: string } | null; restoredAt: number | null };
const backupOf = async (c: Client) => {
  const r = await c.json<{ snapshot: { backup: Backup } }>("GET", "/api/system");
  if (r.status !== 200) throw new Error(`/api/system → ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.snapshot.backup;
};

async function backedUp(c: Client, ms = 30_000) {
  const t0 = Date.now();
  for (;;) {
    const b = await backupOf(c);
    if (!b.pending && b.lastAt) return b;
    if (Date.now() - t0 > ms) throw new Error(`still not backed up: ${JSON.stringify(b)}`);
    await sleep(250);
  }
}

const pinned = () => {
  const { m } = JSON.parse(fs.readFileSync(path.join(SIM_DIR, "pinned.json"), "utf8")) as { m: number };
  const meta = JSON.parse(fs.readFileSync(path.join(SIM_DIR, `msg-${m}.json`), "utf8")) as { caption: string };
  return { m, caption: JSON.parse(meta.caption.slice("#telestorage_backup".length)) as { br: string; rel: number; par: number | null } };
};

const signedIn = async (s: Server, cookie?: string) => {
  const c = new Client(s.url);
  if (cookie) c.cookie = cookie;
  else await c.login(PASSWORD);
  return c;
};
const names = (items: DriveNode[]) => items.map((n) => n.name).sort();

afterAll(async () => {
  for (const s of [...running]) await kill(s);
  await sleep(300);
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const photoBytes = randomBytes(2_600_000); // two parts
const docBytes = Buffer.from("everything comes back\n".repeat(400));
const thumbBytes = randomBytes(30_000);
let photo: DriveNode;
let doc: DriveNode;
let share: Share;
let cookie = "";
let b: Server;
let c: Server;
let d: Server;
let e: Server;

describe("a drive on a host that wipes its disk", () => {
  it("comes back on an empty disk: files, folders, stars, links, thumbnails and the sign-in", async () => {
    const a = await start("a");
    await ready(a);
    const ca = await signedIn(a);
    const folder = await ca.mkdir("Holidays");
    photo = await ca.upload("beach.jpg", photoBytes, { parentId: folder.id });
    doc = await ca.upload("notes.txt", docBytes);
    expect((await ca.json("PATCH", `/api/nodes/${doc.id}`, { starred: true })).status).toBe(200);
    share = (await ca.json<{ share: Share }>("POST", "/api/shares", { nodeIds: [photo.id] }, { "idempotency-key": key("sh") })).body.share;
    const put = await ca.fetch(`/api/thumbs/${photo.id}?w=480&h=320`, { method: "PUT", headers: { "content-type": "image/webp" }, body: new Uint8Array(thumbBytes) });
    expect(put.status).toBe(200);
    await backedUp(ca);
    cookie = ca.cookie;
    await kill(a); // the host wipes the instance

    b = await start("b");
    await ready(b);
    const cb = await signedIn(b, cookie); // still signed in
    const root = await cb.listing();
    expect(names(root)).toEqual(["Holidays", "notes.txt"]);
    expect(root.find((n) => n.name === "notes.txt")?.starred).toBe(true);
    const inFolder = await cb.listing(root.find((n) => n.name === "Holidays")!.id);
    expect(names(inFolder)).toEqual(["beach.jpg"]);
    expect(Buffer.compare((await cb.download(inFolder[0])).data, photoBytes)).toBe(0);
    expect(Buffer.compare((await cb.download(root.find((n) => n.name === "notes.txt")!)).data, docBytes)).toBe(0);

    const visitor = new Client(b.url);
    expect((await visitor.json("GET", `/api/public/${share.id}`)).status).toBe(200);
    const shared = await visitor.fetch(`/api/public/${share.id}/file/${photo.id}/beach.jpg?dl=1`);
    expect(Buffer.compare(Buffer.from(await shared.arrayBuffer()), photoBytes)).toBe(0);

    // The thumbnail was in a pack of its own: fetched from the channel on first view.
    const thumb = await cb.fetch(`/api/thumbs/${inFolder[0].blobId}`);
    expect(thumb.status).toBe(200);
    expect(Buffer.compare(Buffer.from(await thumb.arrayBuffer()), thumbBytes)).toBe(0);

    expect((await backupOf(cb)).restoredAt).toBeTruthy();
  });

  it("hands over on stop: the next server restores at once instead of waiting", async () => {
    const cb = await signedIn(b, cookie);
    await cb.json("PATCH", `/api/nodes/${doc.id}`, { name: "notes-final.txt" });
    expect((await cb.json<{ result: { status: string } }>("POST", "/api/system/handover")).body.result.status).toBe("released");
    expect(pinned().caption.rel).toBe(1);
    await kill(b);

    c = await start("c", { HANDOVER_WAIT_SEC: "60" });
    const waited = await ready(c);
    expect(waited).toBeLessThan(30_000); // no 60 s hand-over wait
    const cc = await signedIn(c, cookie);
    expect(names(await cc.listing())).toEqual(["Holidays", "notes-final.txt"]);
  });

  it("waits briefly for a server that may still be running, and takes its last changes", async () => {
    const cc = await signedIn(c, cookie);
    await cc.mkdir("Late");
    await backedUp(cc);
    expect(pinned().caption.rel).toBe(0);
    await kill(c); // gone without a hand-over

    d = await start("d", { HANDOVER_WAIT_SEC: "5" });
    const seen = new Set<string>();
    // Meanwhile the API says "restoring", not "signed out" and not an error.
    const early = await (await signedIn(d, cookie)).json<{ restoring?: boolean }>("GET", "/api/nodes?parent=root");
    expect(early.status).toBe(503);
    expect(early.body.restoring).toBe(true);
    // The health check still answers (with a session cookie too): hosts keep the instance, the app shows progress.
    const probe = await (await signedIn(d, cookie)).json<Health & { message?: string }>("GET", "/api/health");
    expect(probe.status).toBe(200);
    expect(probe.body).toMatchObject({ restoring: true, ready: false, message: expect.any(String) });
    const waited = await ready(d, 60_000, seen);
    expect(seen.has("waiting")).toBe(true);
    expect(waited).toBeGreaterThan(3000);
    const cd = await signedIn(d, cookie);
    expect(names(await cd.listing())).toEqual(["Holidays", "Late", "notes-final.txt"]);
  });

  it("a server with nothing unsaved follows another that continued from its backup", async () => {
    // e starts while d is still running (a redeploy that overlaps, say).
    e = await start("e");
    await ready(e);
    const ce = await signedIn(e, cookie);
    expect(names(await ce.listing())).toContain("Late");

    const cd = await signedIn(d, cookie);
    await cd.mkdir("From d");
    await backedUp(cd);
    // e is idle and has changed nothing: it switches to d's newer index by itself.
    const t0 = Date.now();
    for (;;) {
      if (names(await ce.listing()).includes("From d")) break;
      if (Date.now() - t0 > 60_000) throw new Error(`e never followed d:\n${e.log.join("")}`);
      await sleep(1000);
    }
  });

  it("two servers changing it at once: the one in use keeps backing up, nothing is deleted", async () => {
    const ce = await signedIn(e, cookie);
    await ce.mkdir("From e");
    await backedUp(ce);
    const eBackup = pinned();

    const cd = await signedIn(d, cookie);
    await cd.mkdir("From d again");
    const status = await backedUp(cd);
    expect(status.notice?.kind).toBe("diverged"); // told, not silently overwritten
    expect(pinned().m).not.toBe(eBackup.m); // d's version is what a restart restores now…
    expect(fs.existsSync(path.join(SIM_DIR, `msg-${eBackup.m}`))).toBe(true); // …and e's backup is still there
  });

  it("`npm run reset` starts an empty drive on purpose, whose first backup takes over the pin", async () => {
    for (const s of [d, e]) await kill(s);
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "telestorage-e2e-reset-"));
    fs.writeFileSync(path.join(data, "fresh-start.json"), JSON.stringify({ at: Date.now() }));
    const fresh = await start("fresh", {}, data);
    await ready(fresh);
    const cf = await signedIn(fresh, cookie);
    expect(await cf.listing()).toEqual([]);
    await cf.mkdir("New start");
    const status = await backedUp(cf);
    expect(status.notice).toBeNull();
    // A server on an empty disk now gets the new drive.
    await kill(fresh);
    const next = await start("next");
    await ready(next);
    expect(names(await (await signedIn(next, cookie)).listing())).toEqual(["New start"]);
  });
});
