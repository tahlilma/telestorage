import "server-only";
import crypto from "node:crypto";
import type { NextRequest } from "next/server";
import type { DriveNode, Share, ShareItem, ShareOptions } from "@/lib/types";
import { logActivity } from "./activity";
import { clientIp, isSecure } from "./auth";
import { config } from "./config";
import { sql, tx } from "./db";
import { emitNodes, parentsOf } from "./events";
import { HttpError, badRequest, notFound } from "./http";
import { newId } from "./ids";
import { metrics } from "./metrics";
import { getNode, isWithin } from "./nodes";

/**
 * Share links. A link points at one or more files/folders and can carry a
 * title and note, a password, an expiry, a download limit, and a view-only
 * switch. Everything is enforced here, server-side, on every public request.
 */

interface Row {
  id: string;
  title: string | null;
  note: string | null;
  passwordHash: string | null;
  allowDownload: number;
  maxDownloads: number | null;
  createdAt: number;
  expiresAt: number | null;
  downloads: number;
  views: number;
  lastAccessAt: number | null;
  kind: "share" | "request";
  maxBytes: number | null;
  received: number;
  receivedBytes: number;
}

const COLS = `id, title, note, password_hash AS passwordHash, allow_download AS allowDownload, max_downloads AS maxDownloads,
  created_at AS createdAt, expires_at AS expiresAt, downloads, views, last_access_at AS lastAccessAt,
  kind, max_bytes AS maxBytes, received, received_bytes AS receivedBytes`;

const MAX_ITEMS = 500;
const getRow = (id: string) => sql(`SELECT ${COLS} FROM shares WHERE id = ?`).get(id) as Row | undefined;

function itemsOf(shareId: string): ShareItem[] {
  const rows = sql(
    `SELECT n.id, n.name, n.kind, n.size, n.mime, n.blob_id AS blobId, n.in_trash AS inTrash,
       (n.blob_id IS NOT NULL AND EXISTS (SELECT 1 FROM thumbs t WHERE t.blob_id = n.blob_id)) AS hasThumb
     FROM share_items si JOIN nodes n ON n.id = si.node_id WHERE si.share_id = ? ORDER BY si.position`,
  ).all(shareId) as (Omit<ShareItem, "inTrash" | "hasThumb"> & { inTrash: number; hasThumb: number })[];
  return rows.map((r) => ({ ...r, inTrash: r.inTrash === 1, hasThumb: r.hasThumb === 1 }));
}

function statusOf(row: Row, items: ShareItem[]): Share["status"] {
  if (row.expiresAt !== null && row.expiresAt <= Date.now()) return "expired";
  if (row.maxDownloads !== null && row.downloads >= row.maxDownloads) return "exhausted";
  if (!items.some((i) => !i.inTrash)) return "unavailable";
  return "active";
}

function toShare(row: Row): Share {
  const items = itemsOf(row.id);
  return {
    id: row.id,
    title: row.title,
    note: row.note,
    hasPassword: row.passwordHash !== null,
    allowDownload: row.allowDownload === 1,
    maxDownloads: row.maxDownloads,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    downloads: row.downloads,
    views: row.views,
    lastAccessAt: row.lastAccessAt,
    status: statusOf(row, items),
    items,
    kind: row.kind,
    maxBytes: row.maxBytes,
    received: row.received,
    receivedBytes: row.receivedBytes,
  };
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

type Input = ShareOptions & { expiresInHours?: unknown };

function text(v: unknown, max: number, field: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw badRequest(`${field} must be text`);
  const s = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (s.length > max) throw badRequest(`${field} is too long (max ${max} characters)`);
  return s || null;
}

function parseOptions(input: Input) {
  const out: Partial<Record<"title" | "note" | "passwordHash" | "allowDownload" | "maxDownloads" | "expiresAt" | "maxBytes", unknown>> = {};
  if ("maxBytes" in input) {
    const n = input.maxBytes;
    if (n === null || n === undefined) out.maxBytes = null;
    else if (!Number.isSafeInteger(n) || (n as number) < 1) throw badRequest("The size limit must be a whole number of bytes");
    else out.maxBytes = n;
  }
  if ("title" in input) out.title = text(input.title, 120, "Title");
  if ("note" in input) out.note = text(input.note, 1000, "Note");
  if ("password" in input) {
    if (input.password === null || input.password === "") out.passwordHash = null;
    else if (typeof input.password !== "string" || input.password.length > 200) throw badRequest("Invalid password");
    else out.passwordHash = hashPassword(input.password);
  }
  if ("allowDownload" in input) out.allowDownload = input.allowDownload === false ? 0 : 1;
  if ("maxDownloads" in input) {
    const n = input.maxDownloads;
    if (n === null || n === undefined) out.maxDownloads = null;
    else if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > 1_000_000) throw badRequest("Download limit must be a whole number from 1");
    else out.maxDownloads = n;
  }
  if ("expiresAt" in input) {
    const at = input.expiresAt;
    if (at === null || at === undefined) out.expiresAt = null;
    else if (typeof at !== "number" || !Number.isFinite(at)) throw badRequest("Invalid expiry");
    else if (at <= Date.now()) throw badRequest("The expiry must be in the future");
    else out.expiresAt = Math.round(at);
  } else if (input.expiresInHours !== undefined) {
    const hours = Number(input.expiresInHours);
    out.expiresAt = Number.isFinite(hours) && hours > 0 ? Date.now() + hours * 3_600_000 : null;
  }
  return out;
}

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

function passwordMatches(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const actual = crypto.scryptSync(password, Buffer.from(salt, "base64url"), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(actual, expected);
}

const COLUMN: Record<string, string> = {
  title: "title",
  note: "note",
  passwordHash: "password_hash",
  allowDownload: "allow_download",
  maxDownloads: "max_downloads",
  expiresAt: "expires_at",
  maxBytes: "max_bytes",
};

// ---------------------------------------------------------------------------
// Owner API
// ---------------------------------------------------------------------------

export function createShare(nodeIds: unknown, input: Input): Share {
  const ids = [...new Set(Array.isArray(nodeIds) ? nodeIds : [])].filter((x): x is string => typeof x === "string");
  if (!ids.length) throw badRequest("Pick at least one file or folder to share");
  if (ids.length > MAX_ITEMS) throw badRequest(`A link can hold at most ${MAX_ITEMS} items`);
  const nodes = ids.map((id) => {
    const n = getNode(id);
    if (!n) throw notFound("File or folder not found");
    if (n.id === "root") throw badRequest("Share individual files or folders, not the whole drive");
    if (n.trashedAt !== null || sql("SELECT in_trash FROM nodes WHERE id = ?").pluck().get(id) === 1) throw badRequest(`“${n.name}” is in the trash`);
    return n;
  });
  const opts = parseOptions(input);
  const id = newId(22);
  tx(() => {
    sql(
      `INSERT INTO shares (id, title, note, password_hash, allow_download, max_downloads, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      opts.title ?? null,
      opts.note ?? null,
      opts.passwordHash ?? null,
      opts.allowDownload ?? 1,
      opts.maxDownloads ?? null,
      Date.now(),
      opts.expiresAt ?? null,
    );
    const insert = sql("INSERT INTO share_items (share_id, node_id, position) VALUES (?, ?, ?)");
    nodes.forEach((n, i) => insert.run(id, n.id, i));
    logActivity({ kind: "share", name: (opts.title as string | null) ?? nodes[0].name, nodeId: nodes[0].id, shareId: id, count: nodes.length });
  });
  emitNodes("share", { parents: parentsOf(ids), ids });
  return toShare(getRow(id)!);
}

/**
 * A file request: a link through which anyone who has it can upload files
 * into `folderId` — and see nothing that's already there.
 */
export function createRequest(folderId: unknown, input: Input): Share {
  const folder = typeof folderId === "string" ? getNode(folderId) : null;
  if (!folder || folder.kind !== "folder") throw badRequest("Pick a folder to collect files into");
  if (sql("SELECT in_trash FROM nodes WHERE id = ?").pluck().get(folder.id) === 1) throw badRequest(`“${folder.name}” is in the trash`);
  const opts = parseOptions(input);
  const id = newId(22);
  const title = (opts.title as string | null) ?? `Files for ${folder.name}`;
  tx(() => {
    sql(
      `INSERT INTO shares (id, kind, title, note, password_hash, allow_download, max_bytes, created_at, expires_at)
       VALUES (?, 'request', ?, ?, ?, 0, ?, ?, ?)`,
    ).run(id, title, opts.note ?? null, opts.passwordHash ?? null, opts.maxBytes ?? null, Date.now(), opts.expiresAt ?? null);
    sql("INSERT INTO share_items (share_id, node_id, position) VALUES (?, ?, 0)").run(id, folder.id);
    logActivity({ kind: "request", name: title, nodeId: folder.id, shareId: id });
  });
  emitNodes("request", { parents: [folder.parentId], ids: [folder.id] });
  return toShare(getRow(id)!);
}

export function updateShare(id: string, input: Input): Share {
  const row = getRow(id);
  if (!row) throw notFound("Link not found");
  const opts = parseOptions(input);
  const keys = Object.keys(opts).filter((k) => k in COLUMN);
  if (keys.length) {
    sql(`UPDATE shares SET ${keys.map((k) => `${COLUMN[k]} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((k) => opts[k as keyof typeof opts] ?? null), id);
  }
  const ids = itemsOf(id).map((i) => i.id);
  emitNodes("share", { parents: parentsOf(ids), ids });
  return toShare(getRow(id)!);
}

export function listShares(nodeId?: string): Share[] {
  const rows = (
    nodeId
      ? sql(`SELECT ${COLS} FROM shares WHERE id IN (SELECT share_id FROM share_items WHERE node_id = ?) ORDER BY created_at DESC`).all(nodeId)
      : sql(`SELECT ${COLS} FROM shares ORDER BY created_at DESC`).all()
  ) as Row[];
  return rows.map(toShare);
}

export function deleteShare(id: string) {
  const row = getRow(id);
  if (!row) return;
  const items = itemsOf(id);
  sql("DELETE FROM shares WHERE id = ?").run(id);
  logActivity({ kind: "unshare", name: row.title ?? items[0]?.name ?? null, shareId: id, count: items.length });
  emitNodes("share", { parents: parentsOf(items.map((i) => i.id)), ids: items.map((i) => i.id) });
}

// ---------------------------------------------------------------------------
// Public access
// ---------------------------------------------------------------------------

export interface ResolvedShare {
  row: Row;
  /** The live shared items. */
  roots: DriveNode[];
  /** More than one item: the link shows a virtual folder of them. */
  bundle: boolean;
  title: string;
}

const unlockCookieName = (id: string) => `tsu_${id}`;
const unlockValue = (row: Row) =>
  crypto.createHmac("sha256", config().auth.secret).update(`share:${row.id}:${row.passwordHash ?? ""}`).digest("base64url");

function isUnlocked(req: NextRequest, row: Row): boolean {
  if (!row.passwordHash) return true;
  const got = req.cookies.get(unlockCookieName(row.id))?.value;
  if (!got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(unlockValue(row));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Resolves a public token or throws the reason it can't be used:
 * 404 unknown/turned off, 410 expired/limit reached/files gone, 401 locked.
 */
export function resolveShare(
  req: NextRequest,
  token: string,
  opts: {
    allowLocked?: boolean;
    /** Which kind of link this endpoint serves. A file request never lists or serves anything. */
    kind?: "share" | "request" | "any";
  } = {},
): ResolvedShare {
  if (!/^[0-9A-Za-z]{10,40}$/.test(token)) throw notFound("This link doesn't exist or was turned off");
  const row = getRow(token);
  if (!row) throw notFound("This link doesn't exist or was turned off");
  const kind = opts.kind ?? "share";
  if (kind !== "any" && row.kind !== kind) throw notFound("This link doesn't exist or was turned off");
  if (row.expiresAt !== null && row.expiresAt <= Date.now()) throw new HttpError(410, "This link has expired", { reason: "expired" });
  if (row.maxDownloads !== null && row.downloads >= row.maxDownloads) {
    throw new HttpError(410, "This link reached its download limit", { reason: "exhausted" });
  }
  const roots = (
    sql(
      `SELECT si.node_id FROM share_items si JOIN nodes n ON n.id = si.node_id
       WHERE si.share_id = ? AND n.in_trash = 0 ORDER BY si.position`,
    )
      .pluck()
      .all(token) as string[]
  )
    .map((id) => getNode(id))
    .filter((n): n is DriveNode => n !== null);
  if (!roots.length) throw new HttpError(410, "The shared files are no longer available", { reason: "unavailable" });
  const title = row.title ?? (roots.length === 1 ? roots[0].name : `${roots.length} items`);
  if (!opts.allowLocked && !isUnlocked(req, row)) {
    throw new HttpError(401, "This link is password-protected", { passwordRequired: true, title });
  }
  return { row, roots, bundle: roots.length > 1, title };
}

/** `nodeId` must be a live item inside one of the shared items. */
export function nodeInShare(r: ResolvedShare, nodeId: string): DriveNode {
  const node = getNode(nodeId);
  if (!node || sql("SELECT in_trash FROM nodes WHERE id = ?").pluck().get(nodeId) === 1) throw notFound();
  if (!r.roots.some((root) => isWithin(nodeId, root.id))) throw notFound();
  return node;
}

/** The shared item that contains `nodeId`. */
export function rootOf(r: ResolvedShare, nodeId: string): DriveNode | undefined {
  return r.roots.find((root) => isWithin(nodeId, root.id));
}

const failures = new Map<string, { count: number; until: number }>();

/** Checks a link password and returns the Set-Cookie that unlocks it for 30 days. */
export function unlockShare(req: NextRequest, token: string, password: unknown): string {
  const r = resolveShare(req, token, { allowLocked: true, kind: "any" });
  if (!r.row.passwordHash) return unlockCookie(req, r.row);
  const key = `${clientIp(req)}:${token}`;
  const f = failures.get(key);
  if (f && f.count >= 8 && f.until > Date.now()) {
    throw new HttpError(429, `Too many attempts. Try again in ${Math.ceil((f.until - Date.now()) / 60_000)} min.`);
  }
  if (typeof password !== "string" || !passwordMatches(password, r.row.passwordHash)) {
    const next = { count: (f && f.until > Date.now() ? f.count : 0) + 1, until: Date.now() + 10 * 60_000 };
    failures.set(key, next);
    metrics.inc("shares.unlockFailures");
    throw new HttpError(401, "Wrong password", { passwordRequired: true, title: r.title });
  }
  failures.delete(key);
  return unlockCookie(req, r.row);
}

function unlockCookie(req: NextRequest, row: Row): string {
  return [
    `${unlockCookieName(row.id)}=${unlockValue(row)}`,
    `Path=/api/public/${row.id}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${30 * 86400}`,
    isSecure(req) ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function countView(r: ResolvedShare) {
  sql("UPDATE shares SET views = views + 1, last_access_at = ? WHERE id = ?").run(Date.now(), r.row.id);
  metrics.inc("shares.views");
  logActivity({ kind: "share_view", name: r.title, shareId: r.row.id });
}

export function countDownload(r: ResolvedShare, name?: string) {
  sql("UPDATE shares SET downloads = downloads + 1, last_access_at = ? WHERE id = ?").run(Date.now(), r.row.id);
  metrics.inc("shares.downloads");
  logActivity({ kind: "share_download", name: name ?? r.title, shareId: r.row.id });
}

/** A file arrived through a file request (called once per landed upload, inside its transaction). */
export function recordReceived(shareId: string, node: DriveNode, from: string | null) {
  const row = getRow(shareId);
  if (!row) return;
  sql("UPDATE shares SET received = received + 1, received_bytes = received_bytes + ?, last_access_at = ? WHERE id = ?").run(node.size, Date.now(), shareId);
  metrics.inc("requests.received");
  logActivity({ kind: "received", name: row.title, nodeId: node.id, parentId: node.parentId, shareId, detail: from ? { from } : undefined });
}

/** What a visitor to a file request sees: no folder name, no contents. */
export function requestInfo(r: ResolvedShare) {
  return { title: r.title, note: r.row.note, maxBytes: r.row.maxBytes, expiresAt: r.row.expiresAt, hasPassword: r.row.passwordHash !== null };
}

const sent = new Map<string, { count: number; since: number }>();

/** Per visitor and request: at most 500 uploads started per hour. */
export function rateLimitRequestUpload(req: NextRequest, r: ResolvedShare) {
  const key = `${clientIp(req)}:${r.row.id}`;
  const now = Date.now();
  const s = sent.get(key);
  const cur = s && now - s.since < 3_600_000 ? s : { count: 0, since: now };
  if (cur.count >= 500) throw new HttpError(429, "Too many uploads from here for now — try again in a while");
  cur.count++;
  sent.set(key, cur);
  if (sent.size > 10_000) for (const [k, v] of sent) if (now - v.since > 3_600_000) sent.delete(k);
}

export function requireDownloads(r: ResolvedShare) {
  if (r.row.allowDownload !== 1) throw new HttpError(403, "Downloads are turned off for this link");
}
