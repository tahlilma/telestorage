import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { body, fileDigests, planChunks, sha, sliceFor } from "../support/upload-client";

/** The photo timeline: newest moment first (taken, else uploaded), paged, photos and videos only. */
process.env.TG_PART_SIZE_MB = "2";
const PART = 2 * 1024 * 1024;

type Runtime = import("@/server/storage").Runtime;
let rt: Runtime;
let up: typeof import("@/server/storage/uploads");
let nodes: typeof import("@/server/nodes");
let shutdown: () => Promise<void>;

beforeAll(async () => {
  const s = await import("@/server/storage");
  rt = await s.storage();
  shutdown = s.shutdownStorage;
  up = await import("@/server/storage/uploads");
  nodes = await import("@/server/nodes");
});

afterAll(async () => {
  await shutdown();
});

async function upload(name: string, mime: string, takenAt?: number) {
  const data = Buffer.from(`${name}-${Math.random()}`.repeat(50));
  const init = up.createUpload(rt, { name, size: data.length, mime, parentId: "root", takenAt });
  if ("node" in init) return init.node;
  for (const r of planChunks(data.length, init.partSize)) {
    const chunk = sliceFor(data, PART, r);
    await up.writeChunk(rt, init.id, r.part, r.offset, body(chunk), { digest: sha(chunk), contentLength: chunk.length });
  }
  const res = await up.completeUpload(rt, init.id, fileDigests(data, PART));
  if (!("node" in res)) throw new Error("did not complete");
  return res.node;
}

describe("photo timeline", () => {
  it("sorts by when photos were taken, pages without gaps or repeats, and skips other files", async () => {
    const day = 86_400_000;
    const old = await upload("old.jpg", "image/jpeg", Date.UTC(2015, 4, 1));
    const recent = await upload("new.jpg", "image/jpeg", Date.now() - day);
    const mid = await upload("mid.mp4", "video/mp4", Date.UTC(2019, 0, 1));
    const untimed = await upload("untimed.png", "image/png");
    await upload("notes.txt", "text/plain");
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page = nodes.listPhotos(cursor, 2);
      ids.push(...page.items.map((p) => p.id));
      cursor = page.next;
    } while (cursor);
    // The untimed one counts as "uploaded just now", so it's newest.
    expect(ids).toEqual([untimed.id, recent.id, mid.id, old.id]);
  });
});
