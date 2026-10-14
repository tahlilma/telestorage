import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { body, fileDigests, planChunks, sha, sliceFor } from "../support/upload-client";

/**
 * Version history: replacing a file keeps the file and its history; earlier
 * versions can be read, restored and deleted; storage held by a version is
 * never garbage-collected while the version exists, and goes when it doesn't.
 */
process.env.TG_PART_SIZE_MB = "2";
process.env.VERSIONS_KEEP = "3";
const PART = 2 * 1024 * 1024;

type Runtime = import("@/server/storage").Runtime;
let rt: Runtime;
let up: typeof import("@/server/storage/uploads");
let nodes: typeof import("@/server/nodes");
let blobs: typeof import("@/server/storage/blobs");
let shares: typeof import("@/server/shares");
let sql: typeof import("@/server/db").sql;
let runFsck: typeof import("@/server/fsck").runFsck;
let kickGc: typeof import("@/server/storage/maintenance").kickGc;
let shutdown: () => Promise<void>;

beforeAll(async () => {
  const s = await import("@/server/storage");
  rt = await s.storage();
  shutdown = s.shutdownStorage;
  up = await import("@/server/storage/uploads");
  nodes = await import("@/server/nodes");
  blobs = await import("@/server/storage/blobs");
  shares = await import("@/server/shares");
  ({ sql } = await import("@/server/db"));
  ({ runFsck } = await import("@/server/fsck"));
  ({ kickGc } = await import("@/server/storage/maintenance"));
});

afterAll(async () => {
  await shutdown();
});

async function upload(data: Buffer, name: string, parentId: string, onConflict: "keep" | "replace" = "keep", takenAt?: number) {
  const init = up.createUpload(rt, { name, size: data.length, mime: "text/plain", parentId, onConflict, takenAt });
  if ("node" in init) return init;
  for (const r of planChunks(data.length, init.partSize)) {
    const chunk = sliceFor(data, PART, r);
    await up.writeChunk(rt, init.id, r.part, r.offset, body(chunk), { digest: sha(chunk), contentLength: chunk.length });
  }
  const res = await up.completeUpload(rt, init.id, fileDigests(data, PART));
  if (!("node" in res)) throw new Error("did not complete");
  return res;
}

async function read(blobId: string) {
  const blob = blobs.loadBlob(blobId)!;
  const reader = blobs.openRangeStream(rt, blob, 0, blob.size - 1).getReader();
  const out: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return Buffer.concat(out);
}

const text = (s: string) => Buffer.from(s.repeat(200));
const blobExists = (id: string) => Boolean(sql("SELECT 1 FROM blobs WHERE id = ?").get(id));

describe("version history", () => {
  it("replacing keeps the file, its link and its star; earlier content stays readable", async () => {
    const folder = nodes.createFolder("root", "versions-basic");
    const v1 = await upload(text("first draft\n"), "essay.txt", folder.id);
    nodes.setStarred([v1.node.id], true);
    const link = shares.createShare([v1.node.id], {});
    const v2 = await upload(text("second draft\n"), "essay.txt", folder.id, "replace");
    expect(v2.node).toMatchObject({ id: v1.node.id, starred: true, versionCount: 1 });
    // The link still points at the same file, which now has the new content.
    expect(sql("SELECT node_id FROM share_items WHERE share_id = ?").pluck().all(link.id)).toEqual([v1.node.id]);
    const [version] = nodes.listVersions(v1.node.id);
    expect(version.size).toBe(v1.node.size);
    const old = nodes.versionContent(v1.node.id, version.id);
    expect((await read(old.blobId)).equals(text("first draft\n"))).toBe(true);
    expect((await read(nodes.getNode(v1.node.id)!.blobId!)).equals(text("second draft\n"))).toBe(true);
  });

  it("restoring a version swaps it back in and keeps what it replaced", async () => {
    const folder = nodes.createFolder("root", "versions-restore");
    const a = await upload(text("A"), "doc.txt", folder.id);
    await upload(text("B"), "doc.txt", folder.id, "replace");
    const [vA] = nodes.listVersions(a.node.id);
    const { node } = nodes.restoreVersion(a.node.id, vA.id);
    expect((await read(node.blobId!)).equals(text("A"))).toBe(true);
    // B is now the version; restoring is never destructive.
    const history = nodes.listVersions(a.node.id);
    expect(history).toHaveLength(1);
    expect((await read(nodes.versionContent(a.node.id, history[0].id).blobId)).equals(text("B"))).toBe(true);
  });

  it("deleting a version frees its storage, unless another file shares it", async () => {
    const folder = nodes.createFolder("root", "versions-delete");
    const f = await upload(text("one"), "x.txt", folder.id);
    const blobOne = f.node.blobId!;
    // A second file with the same bytes shares the stored content (dedup).
    const twin = await upload(text("one"), "twin.txt", folder.id);
    expect(twin.node.blobId).toBe(blobOne);
    await upload(text("two"), "x.txt", folder.id, "replace");
    const blobTwo = nodes.getNode(f.node.id)!.blobId!;
    await upload(text("three"), "x.txt", folder.id, "replace");
    const [vTwo, vOne] = nodes.listVersions(f.node.id);
    expect(nodes.deleteVersion(f.node.id, vOne.id)).toEqual([]); // still used by twin.txt
    expect(blobExists(blobOne)).toBe(true);
    expect(nodes.deleteVersion(f.node.id, vTwo.id)).toEqual([blobTwo]);
    expect(blobExists(blobTwo)).toBe(false);
    await kickGc(rt);
    expect(sql("SELECT COUNT(*) FROM gc_queue").pluck().get()).toBe(0);
  });

  it("keeps the newest VERSIONS_KEEP versions and lets the oldest go", async () => {
    const folder = nodes.createFolder("root", "versions-prune");
    const f = await upload(text("v0"), "log.txt", folder.id);
    const first = f.node.blobId!;
    for (let i = 1; i <= 4; i++) await upload(text(`v${i}`), "log.txt", folder.id, "replace");
    const kept = nodes.listVersions(f.node.id);
    expect(kept).toHaveLength(3);
    expect(blobExists(first)).toBe(false); // v0 was pruned, and nothing else used it
    expect(nodes.getNode(f.node.id)!.versionCount).toBe(3);
  });

  it("fsck treats version content as referenced, and deleting the file takes its versions along", async () => {
    const folder = nodes.createFolder("root", "versions-fsck");
    const f = await upload(text("keep me"), "a.txt", folder.id);
    await upload(text("newer"), "a.txt", folder.id, "replace");
    const versionBlob = nodes.versionContent(f.node.id, nodes.listVersions(f.node.id)[0].id).blobId;
    const report = runFsck({ repair: true });
    expect(report.checks.find((c) => c.name === "Unreferenced content")?.status).toBe("ok");
    expect(blobExists(versionBlob)).toBe(true);
    const purged = nodes.deleteForever([f.node.id]);
    expect(purged).toContain(versionBlob);
    expect(sql("SELECT COUNT(*) FROM versions WHERE node_id = ?").pluck().get(f.node.id)).toBe(0);
  });

  it("remembers when a photo was taken, per version", async () => {
    const folder = nodes.createFolder("root", "versions-taken");
    const shot = Date.UTC(2021, 5, 1, 12);
    const f = await upload(text("img"), "p.jpg", folder.id, "keep", shot);
    expect(f.node.takenAt).toBe(shot);
    await upload(text("img2"), "p.jpg", folder.id, "replace", Date.UTC(2022, 0, 1));
    const [v] = nodes.listVersions(f.node.id);
    expect(nodes.restoreVersion(f.node.id, v.id).node.takenAt).toBe(shot);
    // Implausible times are ignored.
    const g = await upload(text("x"), "q.jpg", folder.id, "keep", Date.now() + 10 * 86_400_000);
    expect(g.node.takenAt).toBeNull();
  });
});

describe("folder colours", () => {
  it("sets and clears a palette colour on folders only", () => {
    const folder = nodes.createFolder("root", "colourful");
    nodes.setColor([folder.id], "blue");
    expect(nodes.getNode(folder.id)!.color).toBe("blue");
    nodes.setColor([folder.id], null);
    expect(nodes.getNode(folder.id)!.color).toBeNull();
    expect(() => nodes.setColor([folder.id], "chartreuse")).toThrow(/Unknown colour/);
  });
});
