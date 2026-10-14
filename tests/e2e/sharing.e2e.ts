import { beforeAll, describe, expect, it } from "vitest";
import type { Activity, DriveNode, HomeData, Share } from "@/lib/types";
import { Client, key, randomBytes, sleep } from "./client";

/**
 * Share links over real HTTP: what the owner configures is exactly what an
 * anonymous visitor gets — and nothing more.
 */
const owner = new Client();
let folder: DriveNode;
let photo: DriveNode;
let doc: DriveNode;
const photoBytes = randomBytes(300_000);

const create = async (body: Record<string, unknown>) => {
  const r = await owner.json<{ share: Share; error?: string }>("POST", "/api/shares", body, { "idempotency-key": key("sh") });
  return r;
};

beforeAll(async () => {
  await owner.login();
  folder = await owner.mkdir(`sharing-${Date.now()}`);
  photo = await owner.upload("photo.jpg", photoBytes, { parentId: folder.id });
  doc = await owner.upload("notes.txt", Buffer.from("hello from telestorage\n".repeat(50)), { parentId: folder.id });
});

describe("share links", () => {
  it("bundles several items into one link, browsable and zippable by anyone", async () => {
    const { status, body } = await create({ nodeIds: [photo.id, doc.id], title: "Two things", note: "Here you go" });
    expect(status).toBe(201);
    expect(body.share.items.map((i) => i.name).sort()).toEqual(["notes.txt", "photo.jpg"]);
    const visitor = new Client();
    const view = await visitor.json<{ share: { title: string; note: string; bundle: boolean }; items: DriveNode[]; path: { id: string }[] }>("GET", `/api/public/${body.share.id}?visit=1`);
    expect(view.status).toBe(200);
    expect(view.body.share).toMatchObject({ title: "Two things", note: "Here you go", bundle: true });
    expect(view.body.items.map((i) => i.name).sort()).toEqual(["notes.txt", "photo.jpg"]);
    // Nothing outside the link leaks: no parent ids, no blob ids.
    expect(view.body.items.every((i) => i.parentId === null && i.blobId === null)).toBe(true);
    const file = await visitor.fetch(`/api/public/${body.share.id}/file/${photo.id}/photo.jpg?dl=1`);
    expect(file.headers.get("content-disposition")).toMatch(/attachment/);
    expect(Buffer.from(await file.arrayBuffer()).equals(photoBytes)).toBe(true);
    const zip = await visitor.fetch(`/api/public/${body.share.id}/zip`);
    expect(zip.status).toBe(200);
    expect(Buffer.from(await zip.arrayBuffer()).subarray(0, 2).toString()).toBe("PK");
    // An item outside the link is out of reach.
    const other = await owner.upload("private.txt", randomBytes(100), { parentId: folder.id });
    expect((await visitor.fetch(`/api/public/${body.share.id}/file/${other.id}/private.txt`)).status).toBe(404);
    // The owner sees the view and both downloads.
    const listed = await owner.json<{ shares: Share[] }>("GET", `/api/shares?nodeId=${photo.id}`);
    const s = listed.body.shares.find((x) => x.id === body.share.id)!;
    expect(s.views).toBe(1);
    expect(s.downloads).toBe(2);
  });

  it("asks for a password, rate-limits guesses, and remembers the visitor once unlocked", async () => {
    const { body } = await create({ nodeIds: [doc.id], password: "open sesame" });
    const visitor = new Client();
    const locked = await visitor.json<{ passwordRequired?: boolean; title?: string }>("GET", `/api/public/${body.share.id}`);
    expect(locked.status).toBe(401);
    expect(locked.body).toMatchObject({ passwordRequired: true, title: "notes.txt" });
    // Files and thumbnails are locked too, not just the listing.
    expect((await visitor.fetch(`/api/public/${body.share.id}/file/${doc.id}/notes.txt`)).status).toBe(401);
    expect((await visitor.json("POST", `/api/public/${body.share.id}/unlock`, { password: "nope" })).status).toBe(401);
    expect((await visitor.json("POST", `/api/public/${body.share.id}/unlock`, { password: "open sesame" })).status).toBe(200);
    expect((await visitor.json("GET", `/api/public/${body.share.id}`)).status).toBe(200);
    expect((await visitor.fetch(`/api/public/${body.share.id}/file/${doc.id}/notes.txt`)).status).toBe(200);
    // Changing the password logs every visitor out of the link.
    await owner.json("PATCH", `/api/shares/${body.share.id}`, { password: "new secret" });
    expect((await visitor.json("GET", `/api/public/${body.share.id}`)).status).toBe(401);
    // Brute force is cut off.
    const guesser = new Client();
    let last = 0;
    for (let i = 0; i < 9; i++) last = (await guesser.json("POST", `/api/public/${body.share.id}/unlock`, { password: `guess-${i}` })).status;
    expect(last).toBe(429);
  });

  it("view-only links serve files inline but refuse downloads and ZIPs", async () => {
    const { body } = await create({ nodeIds: [photo.id], allowDownload: false });
    const visitor = new Client();
    const view = await visitor.json<{ share: { allowDownload: boolean } }>("GET", `/api/public/${body.share.id}`);
    expect(view.body.share.allowDownload).toBe(false);
    const inline = await visitor.fetch(`/api/public/${body.share.id}/file/${photo.id}/photo.jpg`);
    expect(inline.status).toBe(200);
    expect(inline.headers.get("content-disposition") ?? "inline").not.toMatch(/attachment/);
    await inline.arrayBuffer();
    expect((await visitor.fetch(`/api/public/${body.share.id}/file/${photo.id}/photo.jpg?dl=1`)).status).toBe(403);
    expect((await visitor.fetch(`/api/public/${body.share.id}/zip`)).status).toBe(403);
  });

  it("stops working after its download limit", async () => {
    const { body } = await create({ nodeIds: [doc.id], maxDownloads: 2 });
    const visitor = new Client();
    for (let i = 0; i < 2; i++) {
      const r = await visitor.fetch(`/api/public/${body.share.id}/file/${doc.id}/notes.txt?dl=1`);
      expect(r.status).toBe(200);
      await r.arrayBuffer();
    }
    const gone = await visitor.json<{ reason?: string }>("GET", `/api/public/${body.share.id}`);
    expect(gone.status).toBe(410);
    expect(gone.body.reason).toBe("exhausted");
    const listed = await owner.json<{ shares: Share[] }>("GET", `/api/shares?nodeId=${doc.id}`);
    expect(listed.body.shares.find((s) => s.id === body.share.id)?.status).toBe("exhausted");
  });

  it("expires on time, and can be extended or turned off by the owner", async () => {
    expect((await create({ nodeIds: [doc.id], expiresAt: Date.now() - 1000 })).status).toBe(400);
    const { body } = await create({ nodeIds: [doc.id], expiresAt: Date.now() + 1500 });
    const visitor = new Client();
    expect((await visitor.json("GET", `/api/public/${body.share.id}`)).status).toBe(200);
    await sleep(1700);
    const expired = await visitor.json<{ reason?: string }>("GET", `/api/public/${body.share.id}`);
    expect(expired.status).toBe(410);
    expect(expired.body.reason).toBe("expired");
    // Extending it brings it back; turning it off kills it for good.
    expect((await owner.json("PATCH", `/api/shares/${body.share.id}`, { expiresAt: null })).status).toBe(200);
    expect((await visitor.json("GET", `/api/public/${body.share.id}`)).status).toBe(200);
    expect((await owner.json("DELETE", `/api/shares/${body.share.id}`)).status).toBe(200);
    expect((await visitor.json("GET", `/api/public/${body.share.id}`)).status).toBe(404);
  });

  it("goes away with the files: trashed items vanish from links, deleted ones end them", async () => {
    const victim = await owner.upload("short-lived.txt", randomBytes(64), { parentId: folder.id });
    const { body } = await create({ nodeIds: [victim.id] });
    const visitor = new Client();
    await owner.json("POST", "/api/nodes/batch", { op: "trash", ids: [victim.id] }, { "idempotency-key": key("op") });
    expect((await visitor.json<{ reason?: string }>("GET", `/api/public/${body.share.id}`)).body.reason).toBe("unavailable");
    await owner.json("POST", "/api/nodes/batch", { op: "restore", ids: [victim.id] }, { "idempotency-key": key("op") });
    expect((await visitor.json("GET", `/api/public/${body.share.id}`)).status).toBe(200);
    await owner.json("POST", "/api/nodes/batch", { op: "delete", ids: [victim.id] }, { "idempotency-key": key("op") });
    expect((await visitor.json("GET", `/api/public/${body.share.id}`)).status).toBe(404);
  });

  it("shows up in listings, on the home screen and in the activity feed", async () => {
    const shared = await owner.mkdir("shared-folder", folder.id);
    await create({ nodeIds: [shared.id] });
    const listing = await owner.listing(folder.id);
    expect(listing.find((n) => n.id === shared.id)?.shareCount).toBeGreaterThan(0);
    const home = await owner.json<HomeData>("GET", "/api/home");
    expect(home.body.folders.shared.some((f) => f.id === shared.id)).toBe(true);
    expect(home.body.stats.shares).toBeGreaterThan(0);
    const activity = await owner.json<{ items: Activity[] }>("GET", "/api/activity");
    const kinds = new Set(activity.body.items.map((a) => a.kind));
    for (const k of ["share", "share_view", "share_download", "upload"]) expect(kinds.has(k as Activity["kind"])).toBe(true);
  });
});
