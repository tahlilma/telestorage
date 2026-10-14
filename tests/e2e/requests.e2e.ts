import { beforeAll, describe, expect, it } from "vitest";
import type { Activity, DriveNode, Share } from "@/lib/types";
import { fileDigests, planChunks, sliceFor } from "../support/upload-client";
import { Client, contentDigest, key, randomBytes } from "./client";

/**
 * File requests over real HTTP: anyone with the link can send files into one
 * folder — and can't see that folder, anything in it, or anything else.
 */
const owner = new Client();
let folder: DriveNode;

async function createRequest(body: Record<string, unknown>) {
  return owner.json<{ share: Share }>("POST", "/api/shares", { kind: "request", folderId: folder.id, ...body }, { "idempotency-key": key("rq") });
}

/** The visitor's side of the protocol: init → chunks → complete (with part roots). */
async function send(visitor: Client, token: string, name: string, data: Buffer, from?: string) {
  const base = `/api/public/${token}/uploads`;
  const init = await visitor.json<{ id?: string; partSize?: number; done?: boolean; error?: string }>("POST", base, { name, size: data.length, mime: "application/octet-stream", from });
  if (init.status !== 201) return init;
  if (init.body.done) return init;
  const { id, partSize } = init.body as { id: string; partSize: number };
  for (const r of planChunks(data.length, partSize)) {
    const chunk = sliceFor(data, partSize, r);
    const res = await visitor.fetch(`${base}/${id}?part=${r.part}&offset=${r.offset}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream", "content-digest": contentDigest(chunk) },
      body: new Uint8Array(chunk),
    });
    expect(res.status).toBe(200);
    await res.arrayBuffer();
  }
  const { sha256, parts } = fileDigests(data, partSize);
  return visitor.json<{ done?: boolean }>("POST", `${base}/${id}/complete`, { sha256, parts });
}

beforeAll(async () => {
  await owner.login();
  folder = await owner.mkdir(`inbox-${Date.now()}`);
  await owner.upload("private.txt", Buffer.from("not for visitors"), { parentId: folder.id });
});

describe("file requests", () => {
  it("lets a visitor send files in, and shows them nothing", async () => {
    const { status, body } = await createRequest({ title: "Wedding photos", note: "Thanks!", maxBytes: 4 * 1024 * 1024 });
    expect(status).toBe(201);
    expect(body.share).toMatchObject({ kind: "request", title: "Wedding photos", received: 0 });
    const token = body.share.id;
    const visitor = new Client();

    const info = await visitor.json<Record<string, unknown>>("GET", `/api/public/${token}/request`);
    expect(info.status).toBe(200);
    expect(info.body).toEqual({ title: "Wedding photos", note: "Thanks!", maxBytes: 4 * 1024 * 1024, expiresAt: null, hasPassword: false });
    // Nothing about the folder leaks through the share-link endpoints either.
    expect((await visitor.json("GET", `/api/public/${token}`)).status).toBe(404);
    expect((await visitor.fetch(`/api/public/${token}/zip`)).status).toBe(404);

    const data = randomBytes(3 * 1024 * 1024 + 17);
    const sent = await send(visitor, token, "photo.jpg", data, "Aunt May");
    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({ done: true });

    const listing = await owner.listing(folder.id);
    const landed = listing.find((n) => n.name === "photo.jpg")!;
    expect(landed.size).toBe(data.length);
    expect((await owner.download(landed)).data.equals(data)).toBe(true);
    const shares = await owner.json<{ shares: Share[] }>("GET", "/api/shares");
    expect(shares.body.shares.find((s) => s.id === token)).toMatchObject({ received: 1, receivedBytes: data.length });
    const feed = await owner.json<{ items: Activity[] }>("GET", "/api/activity");
    expect(feed.body.items.some((a) => a.kind === "received" && a.detail?.from === "Aunt May")).toBe(true);
  });

  it("never replaces anything, refuses oversized files, and scopes sessions to the request", async () => {
    const { body } = await createRequest({ maxBytes: 1024 * 1024 });
    const token = body.share.id;
    const visitor = new Client();
    // Same name as a file already there: a new, numbered file.
    expect((await send(visitor, token, "private.txt", Buffer.from("hello"))).status).toBe(200);
    const names = (await owner.listing(folder.id)).map((n) => n.name);
    expect(names).toContain("private.txt");
    expect(names).toContain("private (1).txt");
    const original = (await owner.listing(folder.id)).find((n) => n.name === "private.txt")!;
    expect((await owner.download(original)).data.toString()).toBe("not for visitors");
    // Too big: refused before a byte is sent.
    const big = await visitor.json<{ error: string }>("POST", `/api/public/${token}/uploads`, { name: "huge.bin", size: 2 * 1024 * 1024, mime: null });
    expect(big.status).toBe(413);
    // A session the owner started can't be touched through the request.
    const ownerInit = await owner.init("mine.bin", 10, folder.id);
    const hijack = await visitor.fetch(`/api/public/${token}/uploads/${ownerInit.body.id}?part=0&offset=0`, {
      method: "PUT",
      headers: { "content-digest": contentDigest(Buffer.alloc(10)) },
      body: new Uint8Array(10),
    });
    expect(hijack.status).toBe(404);
    expect((await visitor.json("GET", `/api/public/${token}/uploads/${ownerInit.body.id}`)).status).toBe(404);
    // No content dedup for visitors (it would reveal what the owner has).
    const dedup = await visitor.fetch(`/api/public/${token}/uploads/${ownerInit.body.id}/dedup`, { method: "POST", body: "{}" });
    expect(dedup.status).toBe(404);
    await dedup.arrayBuffer();
  });

  it("keeps share links and requests apart", async () => {
    const share = await owner.json<{ share: Share }>("POST", "/api/shares", { nodeIds: [folder.id] }, { "idempotency-key": key("sh") });
    const visitor = new Client();
    // A share link can't be used to upload…
    expect((await visitor.json("POST", `/api/public/${share.body.share.id}/uploads`, { name: "x.txt", size: 1, mime: null })).status).toBe(404);
    expect((await visitor.json("GET", `/api/public/${share.body.share.id}/request`)).status).toBe(404);
  });

  it("asks for the password first, and stops when the folder is gone", async () => {
    const { body } = await createRequest({ password: "letmein" });
    const token = body.share.id;
    const visitor = new Client();
    const locked = await visitor.json<{ passwordRequired?: boolean }>("GET", `/api/public/${token}/request`);
    expect(locked.status).toBe(401);
    expect(locked.body.passwordRequired).toBe(true);
    expect((await visitor.json("POST", `/api/public/${token}/uploads`, { name: "x.txt", size: 1, mime: null })).status).toBe(401);
    expect((await visitor.json("POST", `/api/public/${token}/unlock`, { password: "letmein" })).status).toBe(200);
    expect((await send(visitor, token, "after-unlock.txt", Buffer.from("ok"))).status).toBe(200);

    const doomed = await owner.mkdir("doomed", folder.id);
    const req = await owner.json<{ share: Share }>("POST", "/api/shares", { kind: "request", folderId: doomed.id }, { "idempotency-key": key("rq") });
    await owner.json("POST", "/api/nodes/batch", { op: "trash", ids: [doomed.id] }, { "idempotency-key": key("op") });
    const gone = await new Client().json<{ reason?: string }>("GET", `/api/public/${req.body.share.id}/request`);
    expect(gone.status).toBe(410);
    expect(gone.body.reason).toBe("unavailable");
  });
});
