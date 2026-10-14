import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { DriveNode, PhotosPage, StorageInsights } from "@/lib/types";
import { fileDigests, planChunks, sliceFor } from "../support/upload-client";
import { Client, key, randomBytes } from "./client";

/** The newer server features over real HTTP: digests, warm-up, photos, storage insights, colours. */
const c = new Client();
let folder: DriveNode;

async function uploadWith(name: string, data: Buffer, mime: string, extra: Record<string, unknown> = {}) {
  const init = await c.json<{ id: string; partSize: number }>("POST", "/api/uploads", { name, size: data.length, mime, parentId: folder.id, ...extra }, { "idempotency-key": key("up") });
  expect(init.status).toBe(201);
  for (const r of planChunks(data.length, init.body.partSize)) expect((await c.putChunk(init.body.id, r.part, r.offset, sliceFor(data, init.body.partSize, r))).status).toBe(200);
  const done = await c.json<{ node: DriveNode }>("POST", `/api/uploads/${init.body.id}/complete`, fileDigests(data, init.body.partSize));
  expect(done.status).toBe(200);
  return done.body.node;
}

beforeAll(async () => {
  await c.login();
  folder = await c.mkdir(`features-${Date.now()}`);
});

describe("newer features", () => {
  it("states the whole file's SHA-256 on every response, ranges included (RFC 9530 Repr-Digest)", async () => {
    const data = randomBytes(5 * 1024 * 1024 + 3);
    const node = await uploadWith("digest.bin", data, "application/octet-stream");
    const expected = `sha-256=:${crypto.createHash("sha256").update(data).digest("base64")}:`;
    const range = await c.download(node, "bytes=1000-2000");
    expect(range.status).toBe(206);
    expect(range.headers.get("repr-digest")).toBe(expected);
    expect((await c.download(node)).headers.get("repr-digest")).toBe(expected);
  });

  it("warms a file's first blocks on request", async () => {
    const node = await uploadWith("warm.bin", randomBytes(3 * 1024 * 1024), "application/octet-stream");
    const res = await c.fetch(`/api/nodes/${node.id}/warm`, { method: "POST" });
    expect(res.status).toBe(204);
  });

  it("orders the photo timeline by when photos were taken, a page at a time", async () => {
    const day = 86_400_000;
    const old = await uploadWith("old.jpg", randomBytes(2000), "image/jpeg", { takenAt: Date.UTC(2015, 4, 1) });
    const recent = await uploadWith("new.jpg", randomBytes(2001), "image/jpeg", { takenAt: Date.now() - day });
    const mid = await uploadWith("mid.mp4", randomBytes(2002), "video/mp4", { takenAt: Date.UTC(2019, 0, 1) });
    await uploadWith("not-a-photo.txt", randomBytes(10), "text/plain");
    const all: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { body: PhotosPage } = await c.json<PhotosPage>("GET", `/api/photos?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      all.push(...page.body.items.map((p) => p.id));
      cursor = page.body.next;
    } while (cursor);
    // Newest moment first (other suites' photos, uploaded "now", may come before ours);
    // text files never appear; no duplicates across pages.
    expect(all.indexOf(recent.id)).toBeLessThan(all.indexOf(mid.id));
    expect(all.indexOf(mid.id)).toBeLessThan(all.indexOf(old.id));
    expect(new Set(all).size).toBe(all.length);
  });

  it("explains where the space goes", async () => {
    const big = await uploadWith("biggest.bin", randomBytes(6 * 1024 * 1024), "application/octet-stream");
    const s = await c.json<StorageInsights>("GET", "/api/storage");
    expect(s.status).toBe(200);
    expect(s.body.largest[0].size).toBeGreaterThanOrEqual(big.size);
    expect(s.body.capacity.kind).toBe("disk");
    expect(s.body.live.count).toBeGreaterThan(0);
  });

  it("answers unknown API paths with a JSON 404, not the app's HTML", async () => {
    for (const method of ["GET", "POST", "PUT", "DELETE"]) {
      const res = await c.fetch("/api/no/such/endpoint", { method });
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toMatch(/application\/json/);
      await res.arrayBuffer();
    }
  });

  it("colours folders, and only folders", async () => {
    const sub = await c.mkdir("painted", folder.id);
    const res = await c.json("POST", "/api/nodes/batch", { op: "color", ids: [sub.id], color: "violet" }, { "idempotency-key": key("op") });
    expect(res.status).toBe(200);
    expect((await c.listing(folder.id)).find((n) => n.id === sub.id)?.color).toBe("violet");
    const bad = await c.json("POST", "/api/nodes/batch", { op: "color", ids: [sub.id], color: "beige" }, { "idempotency-key": key("op") });
    expect(bad.status).toBe(400);
  });
});
