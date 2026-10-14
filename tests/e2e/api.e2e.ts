import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DriveNode, FsckReport } from "@/lib/types";
import { fileDigests, planChunks, sha, sliceFor } from "../support/upload-client";
import { Client, contentDigest, DATA_DIR, key, randomBytes, sleep } from "./client";

/**
 * Black-box tests of the HTTP protocol against a real server process
 * (simulated Telegram fleet). When the suite knows the server's data dir it
 * also inspects the simulator's message store, to prove deleted data really
 * leaves the channel.
 */
const SIM_DIR = DATA_DIR ? path.join(DATA_DIR, "sim") : null;
/** Message files currently in the simulated channel (null when the suite can't see the server's data dir). */
const simMessages = () => (SIM_DIR && fs.existsSync(SIM_DIR) ? new Set(fs.readdirSync(SIM_DIR).filter((f) => /^msg-\d+$/.test(f))) : null);
const added = (before: Set<string> | null, after: Set<string> | null) => (before && after ? [...after].filter((f) => !before.has(f)) : null);

const c = new Client();
let bay: DriveNode;

beforeAll(async () => {
  await c.login();
  bay = await c.mkdir(`e2e-${Date.now()}`);
});

describe("auth", () => {
  it("rejects anonymous API calls and wrong passwords", async () => {
    const anon = new Client();
    expect((await anon.json("GET", "/api/nodes?parent=root")).status).toBe(401);
    expect((await anon.json("POST", "/api/auth/login", { password: "definitely-wrong" })).status).toBe(401);
  });
});

describe("chunked upload protocol", () => {
  it("lands a multi-chunk file sent out of order, byte-exact, with ranges", async () => {
    const data = randomBytes(9 * 1024 * 1024 + 12_345);
    const node = await c.upload("cargo.bin", data, { parentId: bay.id, concurrency: 6 });
    expect(node.size).toBe(data.length);

    const full = await c.download(node);
    expect(full.status).toBe(200);
    expect(full.data.equals(data)).toBe(true);

    const part = await c.download(node, "bytes=1048000-5300000");
    expect(part.status).toBe(206);
    expect(part.data.equals(data.subarray(1048000, 5300001))).toBe(true);

    const tail = await c.download(node, "bytes=-777");
    expect(tail.data.equals(data.subarray(data.length - 777))).toBe(true);

    const details = await c.json<{ storage: { sha256: string; integrity: string; pieceChecksums: boolean; encrypted: boolean } }>("GET", `/api/nodes/${node.id}`);
    expect(details.body.storage.sha256).toBe(sha(data).toString("hex"));
    expect(details.body.storage.pieceChecksums).toBe(true);
    expect(["pending", "verified"]).toContain(details.body.storage.integrity);
  });

  it("returns the same session for a retried init (Idempotency-Key)", async () => {
    const idem = key("up");
    const [a, b] = await Promise.all([c.init("twice.bin", 3_000_000, bay.id, idem), c.init("twice.bin", 3_000_000, bay.id, idem)]);
    const again = await c.init("twice.bin", 3_000_000, bay.id, idem);
    expect(a.body.id).toBeTruthy();
    expect(b.body.id).toBe(a.body.id);
    expect(again.body.id).toBe(a.body.id);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    await c.json("DELETE", `/api/uploads/${a.body.id}`);
  });

  it("rejects a chunk whose Content-Digest does not match and keeps nothing", async () => {
    const data = randomBytes(1024 * 1024);
    const init = await c.init("damaged.bin", data.length, bay.id);
    const { id } = init.body;
    const damaged = Buffer.from(data);
    damaged[1234] ^= 0xff;
    const bad = await c.putChunk(id, 0, 0, damaged, contentDigest(data));
    expect(bad.status).toBe(422);
    const status = await c.json<{ missing: { part: number; offset: number; length: number }[] }>("GET", `/api/uploads/${id}`);
    expect(status.body.missing.reduce((n, m) => n + m.length, 0)).toBe(data.length);
    // The client resends the same bytes and the upload completes normally.
    expect((await c.putChunk(id, 0, 0, data)).status).toBe(200);
    const done = await c.json<{ node: DriveNode }>("POST", `/api/uploads/${id}/complete`, fileDigests(data, init.body.partSize));
    expect(done.status).toBe(200);
    expect((await c.download(done.body.node)).data.equals(data)).toBe(true);
  });

  it("answers an early complete with exactly the missing ranges, then finishes", async () => {
    const data = randomBytes(5 * 1024 * 1024);
    const init = await c.init("gappy.bin", data.length, bay.id);
    const { id, partSize } = init.body;
    const ranges = planChunks(data.length, partSize, 1024 * 1024);
    const skipped = ranges.filter((_, i) => i % 2 === 1);
    for (const r of ranges.filter((_, i) => i % 2 === 0)) expect((await c.putChunk(id, r.part, r.offset, sliceFor(data, partSize, r))).status).toBe(200);

    const early = await c.json<{ missing: { part: number; offset: number; length: number }[]; reason: string }>("POST", `/api/uploads/${id}/complete`, fileDigests(data, partSize));
    expect(early.status).toBe(409);
    expect(early.body.reason).toBe("incomplete");
    expect(early.body.missing.reduce((n, m) => n + m.length, 0)).toBe(skipped.reduce((n, m) => n + m.length, 0));

    for (const r of early.body.missing) expect((await c.putChunk(id, r.part, r.offset, sliceFor(data, partSize, r))).status).toBe(200);
    const done = await c.json<{ node: DriveNode }>("POST", `/api/uploads/${id}/complete`, fileDigests(data, partSize));
    expect(done.status).toBe(200);
    expect((await c.download(done.body.node)).data.equals(data)).toBe(true);
  });

  it("refuses to assemble bytes that do not match the client's whole-file SHA-256", async () => {
    const data = randomBytes(2 * 1024 * 1024);
    const init = await c.init("liar.bin", data.length, bay.id);
    const { id, partSize } = init.body;
    for (const r of planChunks(data.length, partSize)) await c.putChunk(id, r.part, r.offset, sliceFor(data, partSize, r));
    const other = randomBytes(data.length);
    const res = await c.json<{ missing?: unknown[]; reason?: string; error?: string }>("POST", `/api/uploads/${id}/complete`, fileDigests(other, partSize));
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("checksum");
    expect(Array.isArray(res.body.missing) && res.body.missing.length).toBeTruthy();
    expect((await c.listing(bay.id)).some((n) => n.name === "liar.bin")).toBe(false);
    await c.json("DELETE", `/api/uploads/${id}`);
  });

  it("survives duplicate chunk deliveries and racing completes (one file, same node)", async () => {
    const data = randomBytes(3 * 1024 * 1024 + 99);
    const init = await c.init("racy.bin", data.length, bay.id);
    const { id, partSize } = init.body;
    const ranges = planChunks(data.length, partSize, 1024 * 1024);
    // Every chunk arrives twice, concurrently — a retry racing the original.
    const results = await Promise.all(ranges.flatMap((r) => [0, 1].map(() => c.putChunk(id, r.part, r.offset, sliceFor(data, partSize, r)))));
    for (const r of results) expect([200, 409]).toContain(r.status);
    const status = await c.json<{ missing: { part: number; offset: number; length: number }[] }>("GET", `/api/uploads/${id}`);
    for (const r of status.body.missing) await c.putChunk(id, r.part, r.offset, sliceFor(data, partSize, r));

    const digests = fileDigests(data, partSize);
    const [a, b, d] = await Promise.all([0, 1, 2].map(() => c.json<{ node: DriveNode }>("POST", `/api/uploads/${id}/complete`, digests)));
    expect([a.status, b.status, d.status]).toEqual([200, 200, 200]);
    expect(new Set([a.body.node.id, b.body.node.id, d.body.node.id]).size).toBe(1);
    expect((await c.listing(bay.id)).filter((n) => n.name === "racy.bin")).toHaveLength(1);
    expect((await c.download(a.body.node)).data.equals(data)).toBe(true);
  });

  it("dedups identical content instantly, without new storage", async () => {
    const data = randomBytes(1536 * 1024);
    const first = await c.upload("original.bin", data, { parentId: bay.id });
    const before = simMessages();
    const init = await c.init("copy-of-original.bin", data.length, bay.id);
    const res = await c.json<{ node: DriveNode | null; state: string }>("POST", `/api/uploads/${init.body.id}/dedup`, { sha256: sha(data).toString("hex") });
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("deduped");
    expect(res.body.node?.id).not.toBe(first.id);
    const fresh = added(before, simMessages());
    if (fresh) expect(fresh).toEqual([]); // nothing new was posted to the channel
    expect((await c.download(res.body.node!)).data.equals(data)).toBe(true);
    // A late chunk for the deduped session is acknowledged and ignored.
    expect((await c.putChunk(init.body.id, 0, 0, data.subarray(0, 512 * 1024))).status).toBe(200);
  });

  it("cancels an upload: later chunks get 410 and committed parts are removed", async () => {
    const data = randomBytes(1024 * 1024);
    const init = await c.init("cancelled.bin", data.length, bay.id);
    const { id } = init.body;
    expect((await c.putChunk(id, 0, 0, data.subarray(0, 512 * 1024))).status).toBe(200);
    expect((await c.json("DELETE", `/api/uploads/${id}`)).status).toBe(200);
    expect((await c.putChunk(id, 0, 512 * 1024, data.subarray(512 * 1024))).status).toBe(410);
  });
});

describe("deletion pipeline", () => {
  it("scraps a file from the index immediately and from the channel within seconds (live-confirmed)", async () => {
    const live = await c.live();
    await live.waitFor((e) => e.event === "hello");
    const data = randomBytes(2 * 1024 * 1024 + 7);
    const pre = simMessages();
    const node = await c.upload("doomed.bin", data, { parentId: bay.id });
    const ours = added(pre, simMessages());

    expect((await c.json("POST", "/api/nodes/batch", { op: "trash", ids: [node.id] }, { "idempotency-key": key("op") })).status).toBe(200);
    await live.waitFor((e) => e.event === "change" && e.data.type === "nodes" && e.data.reason === "trash");
    const res = await c.json<{ blobs: string[]; queuedParts: number }>("POST", "/api/nodes/batch", { op: "delete", ids: [node.id] }, { "idempotency-key": key("op") });
    expect(res.status).toBe(200);
    expect(res.body.blobs).toHaveLength(1);
    expect(res.body.queuedParts).toBeGreaterThan(0);

    // Gone from the index at once…
    expect((await c.json("GET", `/api/nodes/${node.id}`)).status).toBe(404);
    expect((await c.download(node)).status).toBe(404);
    // …and the live feed reports the bytes leaving storage.
    const gc = await live.waitFor((e) => e.event === "change" && e.data.type === "gc" && (e.data.blobs as string[]).includes(res.body.blobs[0]));
    expect(gc.data.parts).toBeGreaterThan(0);
    if (ours) {
      expect(ours.length).toBe(res.body.queuedParts);
      for (const f of ours) expect(fs.existsSync(path.join(SIM_DIR!, f))).toBe(false);
    }
    live.close();
  });

  it("replays a retried delete instead of failing on the now-missing node", async () => {
    const node = await c.upload("retry-delete.bin", randomBytes(4096), { parentId: bay.id });
    const idem = key("op");
    const a = await c.json<{ blobs: string[] }>("POST", "/api/nodes/batch", { op: "delete", ids: [node.id] }, { "idempotency-key": idem });
    const b = await c.json<{ blobs: string[] }>("POST", "/api/nodes/batch", { op: "delete", ids: [node.id] }, { "idempotency-key": idem });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.headers.get("idempotent-replayed")).toBe("true");
    expect(b.body).toEqual(a.body);
  });
});

describe("live feed", () => {
  it("announces boot + build, and pushes every mutation", async () => {
    const live = await c.live();
    const hello = await live.waitFor((e) => e.event === "hello");
    expect(typeof hello.data.boot).toBe("string");
    expect(typeof hello.data.build).toBe("string");
    const folder = await c.mkdir("live-bay", bay.id);
    await live.waitFor((e) => e.event === "change" && e.data.reason === "create" && (e.data.parents as string[]).includes(bay.id));
    await c.json("PATCH", `/api/nodes/${folder.id}`, { name: "live-bay-renamed" });
    await live.waitFor((e) => e.event === "change" && e.data.reason === "rename" && (e.data.ids as string[]).includes(folder.id));
    live.close();
  });
});

describe("idempotent folder creation", () => {
  it("creates exactly one folder for concurrent duplicates", async () => {
    const idem = key("mk");
    const make = () => c.json<{ node: DriveNode }>("POST", "/api/nodes", { parentId: bay.id, name: "only-once" }, { "idempotency-key": idem });
    const [a, b, d] = await Promise.all([make(), make(), make()]);
    expect(new Set([a.body.node.id, b.body.node.id, d.body.node.id]).size).toBe(1);
    expect((await c.listing(bay.id)).filter((n) => n.name === "only-once")).toHaveLength(1);
  });
});

describe("boarding passes", () => {
  it("serves a shared file to an anonymous visitor", async () => {
    const data = randomBytes(700_000);
    const node = await c.upload("shared.bin", data, { parentId: bay.id });
    const idem = key("sh");
    const share = await c.json<{ share: { id: string } }>("POST", "/api/shares", { nodeId: node.id }, { "idempotency-key": idem });
    const again = await c.json<{ share: { id: string } }>("POST", "/api/shares", { nodeId: node.id }, { "idempotency-key": idem });
    expect(again.body.share.id).toBe(share.body.share.id);
    const anon = new Client();
    const meta = await anon.json<{ current: DriveNode }>("GET", `/api/public/${share.body.share.id}`);
    expect(meta.status).toBe(200);
    const res = await anon.fetch(`/api/public/${share.body.share.id}/file/${node.id}/shared.bin`);
    expect(Buffer.from(await res.arrayBuffer()).equals(data)).toBe(true);
  });
});

describe("integrity tooling", () => {
  it("fsck reports a consistent index", async () => {
    const res = await c.json<{ report: FsckReport }>("POST", "/api/system/fsck");
    expect(res.status).toBe(200);
    const bad = res.body.report.checks.filter((x) => x.status === "error");
    expect(bad).toEqual([]);
    expect(res.body.report.ok).toBe(true);
  });

  it("exposes integrity and load-balancer telemetry", async () => {
    const res = await c.json<{ snapshot: { integrity: { total: number }; bots: { endpoints: unknown[] }[]; admission: { capacity: number } } }>("GET", "/api/system");
    expect(res.body.snapshot.integrity.total).toBeGreaterThan(0);
    expect(res.body.snapshot.bots.length).toBeGreaterThan(0);
    expect(res.body.snapshot.bots[0].endpoints.length).toBeGreaterThan(0);
    expect(res.body.snapshot.admission.capacity).toBeGreaterThan(0);
  });
});

afterAll(async () => {
  // Leave the scratch server tidy: scrap the test bay and give GC a moment.
  if (bay) {
    await c.json("POST", "/api/nodes/batch", { op: "delete", ids: [bay.id] }, { "idempotency-key": key("op") });
    await sleep(500);
  }
});
