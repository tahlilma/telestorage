import { beforeAll, describe, expect, it } from "vitest";
import type { Activity, DriveNode } from "@/lib/types";
import { fileDigests, planChunks, sha, sliceFor } from "../support/upload-client";
import { Client, key, randomBytes } from "./client";

/**
 * "What happens if I upload a duplicate?" — over real HTTP, the way the
 * browser does it: ask about conflicts, then init / chunks / dedup / complete.
 */
const c = new Client();
let folder: DriveNode;

type Outcome = { node: DriveNode; outcome: string };

async function upload(name: string, data: Buffer, parentId: string, onConflict = "keep"): Promise<Outcome> {
  const init = await c.json<{ id: string; partSize: number } | Outcome>("POST", "/api/uploads", { name, size: data.length, mime: null, parentId, onConflict }, { "idempotency-key": `dup-${Math.random().toString(36).slice(2)}-x` });
  if ("node" in init.body) return init.body;
  const { id, partSize } = init.body;
  for (const r of planChunks(data.length, partSize, 2 * 1024 * 1024)) expect((await c.putChunk(id, r.part, r.offset, sliceFor(data, partSize, r))).status).toBe(200);
  const done = await c.json<Outcome>("POST", `/api/uploads/${id}/complete`, fileDigests(data, partSize));
  expect(done.status).toBe(200);
  return done.body;
}

/** Init + dedup only, as the browser does once it knows the hash: no bytes sent. */
async function dedup(name: string, data: Buffer, parentId: string): Promise<{ node: DriveNode | null; state: string; outcome?: string }> {
  const init = await c.json<{ id: string }>("POST", "/api/uploads", { name, size: data.length, mime: null, parentId }, { "idempotency-key": `dd-${Math.random().toString(36).slice(2)}-x` });
  return (await c.json<{ node: DriveNode | null; state: string; outcome?: string }>("POST", `/api/uploads/${init.body.id}/dedup`, { sha256: sha(data).toString("hex") })).body;
}

const names = async (id: string) => (await c.listing(id)).map((n) => n.name).sort();

beforeAll(async () => {
  await c.login();
  folder = await c.mkdir(`dupes-${Date.now()}`);
});

describe("duplicate uploads", () => {
  it("the same file twice in one folder: the second lands on the first, nothing new is stored", async () => {
    const data = randomBytes(2 * 1024 * 1024 + 3);
    const first = await upload("holiday.jpg", data, folder.id);
    expect(first.outcome).toBe("created");
    const viaDedup = await dedup("holiday.jpg", data, folder.id);
    expect(viaDedup).toMatchObject({ state: "deduped", outcome: "identical" });
    expect(viaDedup.node?.id).toBe(first.node.id);
    const viaUpload = await upload("holiday.jpg", data, folder.id); // even when every byte is sent
    expect(viaUpload.outcome).toBe("identical");
    expect(await names(folder.id)).toEqual(["holiday.jpg"]);
    const feed = await c.json<{ items: Activity[] }>("GET", "/api/activity");
    expect(feed.body.items.some((a) => a.kind === "duplicate" && a.name === "holiday.jpg")).toBe(true);
  });

  it("the same bytes under another name or folder: linked instantly, no re-upload", async () => {
    const data = randomBytes(700_000);
    const a = await upload("a.bin", data, folder.id);
    const other = await c.mkdir("elsewhere", folder.id);
    const b = await dedup("copy-of-a.bin", data, other.id);
    expect(b).toMatchObject({ state: "deduped", outcome: "created" });
    expect(b.node?.blobId === null || typeof b.node?.blobId === "string").toBe(true);
    const back = await c.download(b.node!);
    expect(back.data.equals(data)).toBe(true);
    expect(a.node.id).not.toBe(b.node!.id);
  });

  it("the conflict check lists taken names (also inside sub-folders) before any upload", async () => {
    const sub = await c.json<{ folders: Record<string, string> }>("POST", "/api/nodes/mkdirp", { parentId: folder.id, paths: ["Docs"] }, { "idempotency-key": `mk-${Date.now()}-abc` });
    await upload("cv.pdf", randomBytes(10), sub.body.folders["Docs"]);
    const r = await c.json<{ conflicts: { path: string; size: number }[] }>("POST", "/api/nodes/conflicts", {
      parentId: folder.id,
      paths: ["holiday.jpg", "Docs/cv.pdf", "Docs/new.pdf", "nothing.txt"],
    });
    expect(r.body.conflicts.map((x) => x.path).sort()).toEqual(["Docs/cv.pdf", "holiday.jpg"]);
  });

  it("keep both / replace / skip do what they say", async () => {
    const box = await c.mkdir("policies", folder.id);
    const original = await upload("report.pdf", randomBytes(1000), box.id);
    const kept = await upload("report.pdf", randomBytes(1001), box.id, "keep");
    expect(kept).toMatchObject({ outcome: "renamed", node: { name: "report (1).pdf" } });
    const skipped = await upload("report.pdf", randomBytes(1002), box.id, "skip");
    expect(skipped).toMatchObject({ outcome: "skipped", node: { id: original.node.id } });
    const replaced = await upload("report.pdf", randomBytes(1003), box.id, "replace");
    // Same file (links and stars survive), new content; the old content is a version.
    expect(replaced).toMatchObject({ outcome: "replaced", node: { id: original.node.id, name: "report.pdf", size: 1003 } });
    expect(await names(box.id)).toEqual(["report (1).pdf", "report.pdf"]);
    const versions = await c.json<{ versions: { id: string; size: number }[] }>("GET", `/api/nodes/${original.node.id}/versions`);
    expect(versions.body.versions.map((v) => v.size)).toEqual([1000]);
    // Restoring brings the original bytes back, and keeps the replaced ones as a version.
    const restore = await c.json<{ node: DriveNode }>("POST", `/api/nodes/${original.node.id}/versions/${versions.body.versions[0].id}/restore`, {}, { "idempotency-key": key("rv") });
    expect(restore.status).toBe(200);
    expect(restore.body.node.size).toBe(1000);
    const old = await c.download(restore.body.node);
    expect(old.data.length).toBe(1000);
    const after = await c.json<{ versions: { id: string; size: number }[] }>("GET", `/api/nodes/${original.node.id}/versions`);
    expect(after.body.versions.map((v) => v.size)).toEqual([1003]);
    // Earlier versions download too.
    const v = await c.fetch(`/api/files/${original.node.id}/report.pdf?v=${after.body.versions[0].id}`);
    expect(Buffer.from(await v.arrayBuffer()).length).toBe(1003);
  });

  it("uploading a folder again merges into the one that exists", async () => {
    const first = await c.json<{ folders: Record<string, string> }>("POST", "/api/nodes/mkdirp", { parentId: folder.id, paths: ["Album", "Album/2024"] }, { "idempotency-key": `mk-${Date.now()}-a1` });
    const again = await c.json<{ folders: Record<string, string> }>("POST", "/api/nodes/mkdirp", { parentId: folder.id, paths: ["Album", "Album/2024", "Album/2025"] }, { "idempotency-key": `mk-${Date.now()}-a2` });
    expect(again.body.folders["Album/2024"]).toBe(first.body.folders["Album/2024"]);
    expect((await names(folder.id)).filter((n) => n === "Album")).toHaveLength(1);
  });

  it("renaming onto a taken name is refused with a clear message", async () => {
    const one = await upload("one.txt", randomBytes(5), folder.id);
    await upload("two.txt", randomBytes(6), folder.id);
    const r = await c.json<{ error: string }>("PATCH", `/api/nodes/${one.node.id}`, { name: "two.txt" });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/already a file named “two.txt”/);
  });
});
