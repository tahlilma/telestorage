import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { body, fileDigests, planChunks, sha, sliceFor } from "../support/upload-client";

/**
 * What happens when the same thing is uploaded twice. One placement rule
 * covers every path into a folder (upload, dedup, completion, folder upload,
 * move, copy, restore): identical bytes under the same name are never stored
 * or listed twice, and live siblings never share a name.
 */
process.env.TG_PART_SIZE_MB = "2";
const PART = 2 * 1024 * 1024;

type Runtime = import("@/server/storage").Runtime;
let rt: Runtime;
let up: typeof import("@/server/storage/uploads");
let nodes: typeof import("@/server/nodes");
let sql: typeof import("@/server/db").sql;
let shutdown: () => Promise<void>;

beforeAll(async () => {
  const s = await import("@/server/storage");
  rt = await s.storage();
  shutdown = s.shutdownStorage;
  up = await import("@/server/storage/uploads");
  nodes = await import("@/server/nodes");
  ({ sql } = await import("@/server/db"));
});

afterAll(async () => {
  await shutdown();
});

type Policy = "keep" | "replace" | "skip";

/** The browser's protocol: init → every chunk → complete with SHA-256 + window hashes. */
async function upload(data: Buffer, name: string, parentId = "root", onConflict: Policy = "keep") {
  const init = up.createUpload(rt, { name, size: data.length, mime: "application/octet-stream", parentId, onConflict });
  if ("node" in init) return init;
  for (const r of planChunks(data.length, init.partSize)) {
    const chunk = sliceFor(data, PART, r);
    await up.writeChunk(rt, init.id, r.part, r.offset, body(chunk), { digest: sha(chunk), contentLength: chunk.length });
  }
  const res = await up.completeUpload(rt, init.id, fileDigests(data, PART));
  if (!("node" in res)) throw new Error("did not complete");
  return res;
}

const names = (parentId: string) =>
  (sql("SELECT name FROM nodes WHERE parent_id = ? AND in_trash = 0 ORDER BY name").pluck().all(parentId) as string[]).sort();
const blobCount = () => sql("SELECT COUNT(*) FROM blobs").pluck().get() as number;
const rand = (n: number) => crypto.randomBytes(n);

describe("uploading duplicates", () => {
  it("re-uploading the identical file into the same folder creates nothing new", async () => {
    const folder = nodes.createFolder("root", "same-file");
    const data = rand(3 * 1024 * 1024 + 11);
    const first = await upload(data, "photo.jpg", folder.id);
    expect(first.outcome).toBe("created");
    const blobs = blobCount();

    // Full upload of the same bytes (as if dedup never ran): lands on the existing file.
    const again = await upload(data, "photo.jpg", folder.id);
    expect(again.outcome).toBe("identical");
    expect(again.node.id).toBe(first.node.id);
    expect(blobCount()).toBe(blobs); // the second copy's parts were released, not kept
    expect(names(folder.id)).toEqual(["photo.jpg"]);

    // And through dedup (the browser's normal path once the hash is known).
    const init = up.createUpload(rt, { name: "photo.jpg", size: data.length, mime: null, parentId: folder.id }) as { id: string };
    const dd = up.dedupeUpload(rt, init.id, { sha256: sha(data).toString("hex") });
    expect(dd).toMatchObject({ state: "deduped", outcome: "identical" });
    expect(dd.node?.id).toBe(first.node.id);
    expect(names(folder.id)).toEqual(["photo.jpg"]);
  });

  it("identical bytes under another name are linked instantly, without storing them again", async () => {
    const folder = nodes.createFolder("root", "same-bytes");
    const data = rand(1024 * 1024 + 5);
    const first = await upload(data, "a.bin", folder.id);
    const blobs = blobCount();
    const init = up.createUpload(rt, { name: "b.bin", size: data.length, mime: null, parentId: folder.id }) as { id: string };
    const dd = up.dedupeUpload(rt, init.id, { sha256: sha(data).toString("hex") });
    expect(dd.outcome).toBe("created");
    expect(dd.node?.blobId).toBe(first.node.blobId);
    expect(blobCount()).toBe(blobs);
    expect(names(folder.id)).toEqual(["a.bin", "b.bin"]);
  });

  it("a different file with a taken name keeps both by default: name (1), name (2)…", async () => {
    const folder = nodes.createFolder("root", "keep-both");
    await upload(rand(1000), "report.pdf", folder.id);
    const second = await upload(rand(1000), "report.pdf", folder.id);
    const third = await upload(rand(1000), "Report.PDF", folder.id); // case-insensitive
    expect(second).toMatchObject({ outcome: "renamed", node: { name: "report (1).pdf" } });
    expect(third).toMatchObject({ outcome: "renamed", node: { name: "Report (2).PDF" } });
    // Numbering continues from the original stem rather than nesting.
    const fourth = await upload(rand(1000), "report (1).pdf", folder.id);
    expect(fourth.node.name).toBe("report (3).pdf");
    expect(names(folder.id)).toEqual(["Report (2).PDF", "report (1).pdf", "report (3).pdf", "report.pdf"].sort());
  });

  it("replace keeps the file and moves the old content into its version history", async () => {
    const folder = nodes.createFolder("root", "replace");
    const old = await upload(rand(4000), "notes.txt", folder.id);
    const fresh = await upload(rand(5000), "notes.txt", folder.id, "replace");
    expect(fresh.outcome).toBe("replaced");
    // Same file (same id: links and stars survive), new content, old one kept.
    expect(fresh.node).toMatchObject({ id: old.node.id, name: "notes.txt", size: 5000, versionCount: 1 });
    expect(names(folder.id)).toEqual(["notes.txt"]);
    expect(nodes.listTrash().map((n) => n.id)).not.toContain(old.node.id);
    expect(nodes.listVersions(old.node.id)).toMatchObject([{ size: 4000 }]);
  });

  it("skip leaves an existing file alone and uploads nothing", async () => {
    const folder = nodes.createFolder("root", "skip");
    const existing = await upload(rand(3000), "keep.me", folder.id);
    const sessions = sql("SELECT COUNT(*) FROM upload_sessions").pluck().get();
    const res = up.createUpload(rt, { name: "keep.me", size: 99, mime: null, parentId: folder.id, onConflict: "skip" });
    expect(res).toMatchObject({ outcome: "skipped", node: { id: existing.node.id } });
    expect(sql("SELECT COUNT(*) FROM upload_sessions").pluck().get()).toBe(sessions);
    // Skip only applies to taken names.
    const other = up.createUpload(rt, { name: "new.me", size: 3, mime: null, parentId: folder.id, onConflict: "skip" });
    expect("id" in other).toBe(true);
  });

  it("two identical uploads at the same time end up as one stored copy", async () => {
    const folder = nodes.createFolder("root", "concurrent");
    const data = rand(2 * 1024 * 1024 + 77);
    const blobs = blobCount();
    const [a, b] = await Promise.all([upload(data, "one.bin", folder.id), upload(data, "two.bin", folder.id)]);
    expect(a.node.blobId).toBe(b.node.blobId);
    expect(blobCount()).toBe(blobs + 1);
    // Same name too: only one file appears.
    const [c, d] = await Promise.all([upload(data, "same.bin", folder.id), upload(data, "same.bin", folder.id)]);
    expect(new Set([c.node.id, d.node.id]).size).toBe(1);
    expect(names(folder.id)).toEqual(["one.bin", "same.bin", "two.bin"]);
    expect(blobCount()).toBe(blobs + 1);
  });

  it("zero-byte files follow the same rules", async () => {
    const folder = nodes.createFolder("root", "empty-files");
    const a = up.createUpload(rt, { name: ".keep", size: 0, mime: null, parentId: folder.id });
    const b = up.createUpload(rt, { name: ".keep", size: 0, mime: null, parentId: folder.id });
    expect(a).toMatchObject({ outcome: "created" });
    expect(b).toMatchObject({ outcome: "identical" });
    expect(names(folder.id)).toEqual([".keep"]);
  });
});

describe("folders and moves", () => {
  it("uploading a folder again merges into the existing one", async () => {
    const parent = nodes.createFolder("root", "merge");
    const first = nodes.mkdirp(parent.id, ["Photos", "Photos/2024", "Photos/2024/Summer"]);
    const second = nodes.mkdirp(parent.id, ["photos/2024/summer", "Photos/2025"]);
    expect(second["photos/2024/summer"]).toBe(first["Photos/2024/Summer"]);
    expect(names(parent.id)).toEqual(["Photos"]);
    expect(names(first["Photos"])).toEqual(["2024", "2025"]);
  });

  it("reports which files of an upload already exist, including inside sub-folders", async () => {
    const parent = nodes.createFolder("root", "conflicts");
    const dirs = nodes.mkdirp(parent.id, ["Docs"]);
    await upload(rand(10), "cv.pdf", dirs["Docs"]);
    await upload(rand(10), "top.txt", parent.id);
    const found = nodes.findConflicts(parent.id, ["Docs/cv.pdf", "Docs/new.pdf", "top.txt", "Missing/cv.pdf", "TOP.TXT"]);
    expect(found.map((c) => c.path).sort()).toEqual(["Docs/cv.pdf", "TOP.TXT", "top.txt"]);
  });

  it("never lets a move, copy, new folder or rename create a clash", async () => {
    const a = nodes.createFolder("root", "clash-a");
    const b = nodes.createFolder("root", "clash-b");
    const inA = await upload(rand(10), "x.txt", a.id);
    await upload(rand(11), "x.txt", b.id);
    nodes.move([inA.node.id], b.id);
    expect(nodes.getNode(inA.node.id)?.name).toBe("x (1).txt");
    const copied = nodes.copy([inA.node.id], b.id);
    expect(copied[0].name).toBe("x (2).txt");
    expect(nodes.createFolder(b.id, "New folder").name).toBe("New folder");
    expect(nodes.createFolder(b.id, "New folder").name).toBe("New folder (1)");
    expect(() => nodes.rename(inA.node.id, "X.TXT")).toThrow(/already a file named/);
    // Renaming to a different case of its own name is fine.
    expect(nodes.rename(copied[0].id, "X (2).TXT").name).toBe("X (2).TXT");
    // A file and a folder may share a name.
    expect(nodes.createFolder(b.id, "x.txt").name).toBe("x.txt");
  });
});
