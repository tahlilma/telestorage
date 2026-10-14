import "server-only";
import { FOLDER_COLORS, type ConflictPolicy, type Crumb, type DriveNode, type FileVersion, type FolderColor, type FolderListing, type NodeKind, type UploadOutcome } from "@/lib/types";
import { logActivity } from "./activity";
import { config } from "./config";
import { sql, tx } from "./db";
import { emitNodes, parentsOf } from "./events";
import { badRequest, conflict, notFound } from "./http";
import { newId } from "./ids";
import { forgetBlobMeta } from "./storage/blobs";

export const ROOT_ID = "root";

const COLS = `n.id, n.parent_id AS parentId, n.kind, n.name, n.size, n.mime, n.blob_id AS blobId, n.starred,
  n.trashed_at AS trashedAt, n.created_at AS createdAt, n.updated_at AS updatedAt, n.color, n.taken_at AS takenAt,
  CASE WHEN n.kind = 'file' THEN (SELECT COUNT(*) FROM versions v WHERE v.node_id = n.id) END AS versionCount,
  (n.blob_id IS NOT NULL AND EXISTS (SELECT 1 FROM thumbs t WHERE t.blob_id = n.blob_id)) AS hasThumb,
  CASE WHEN n.kind = 'folder' THEN (SELECT COUNT(*) FROM nodes c WHERE c.parent_id = n.id AND c.in_trash = 0) END AS childCount,
  CASE WHEN n.kind = 'folder' THEN (SELECT COALESCE(SUM(c.size), 0) FROM nodes c WHERE c.parent_id = n.id AND c.in_trash = 0 AND c.kind = 'file') END AS folderSize,
  CASE WHEN n.kind = 'folder' THEN (
    SELECT json_group_array(p.blob_id) FROM (
      SELECT c.blob_id FROM nodes c JOIN thumbs t ON t.blob_id = c.blob_id
      WHERE c.parent_id = n.id AND c.in_trash = 0 ORDER BY c.created_at DESC LIMIT 3
    ) p
  ) END AS previews,
  (SELECT COUNT(*) FROM share_items si JOIN shares s ON s.id = si.share_id
    WHERE si.node_id = n.id AND (s.expires_at IS NULL OR s.expires_at > unixepoch() * 1000)) AS shareCount`;

type Row = Omit<DriveNode, "starred" | "hasThumb" | "previews"> & { starred: number; hasThumb: number; previews: string | null };
const toNode = (r: Row): DriveNode => ({
  ...r,
  starred: r.starred === 1,
  hasThumb: r.hasThumb === 1,
  previews: r.previews ? (JSON.parse(r.previews) as string[]) : null,
});
const toNodes = (rows: unknown[]) => (rows as Row[]).map(toNode);

/** Recursive CTE expanding a JSON array of ids into the ids plus all descendants. */
const SUBTREE = `WITH RECURSIVE sub(id) AS (
  SELECT value FROM json_each(?)
  UNION SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id
)`;

export function cleanName(raw: unknown): string {
  if (typeof raw !== "string") throw badRequest("Name is required");
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!name || name === "." || name === "..") throw badRequest("Invalid name");
  if (name.includes("/")) throw badRequest('Names cannot contain "/"');
  if (name.length > 255) throw badRequest("Name is too long (max 255 characters)");
  return name;
}

// ---------------------------------------------------------------------------
// Names. One rule everywhere: live siblings of the same kind never share a
// name (case-insensitively). Collisions become "name (1).ext", "name (2).ext"…
// ---------------------------------------------------------------------------

/** "report.final.pdf" → ["report.final", ".pdf"]; folders, dotfiles and dot-less names keep the whole name. */
function splitName(name: string, kind: NodeKind): [string, string] {
  if (kind === "folder") return [name, ""];
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
}

/** "photo (3)" → "photo": numbering continues from the original name. */
const stemOf = (base: string) => /^(.*\S) \(\d+\)$/.exec(base)?.[1] ?? base;
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

interface Sibling {
  id: string;
  name: string;
  size: number;
  blobId: string | null;
  sha256: string | null;
}

/** Live siblings of one kind named `name` or a numbered variant of it ("base (n).ext"). */
function nameFamily(parentId: string, name: string, kind: NodeKind, exclude: string[] = []): Sibling[] {
  const [base, ext] = splitName(name, kind);
  const stem = stemOf(base);
  return sql(
    `SELECT n.id, n.name, n.size, n.blob_id AS blobId, b.sha256 FROM nodes n LEFT JOIN blobs b ON b.id = n.blob_id
     WHERE n.parent_id = ? AND n.kind = ? AND n.in_trash = 0
       AND (n.name = ? COLLATE NOCASE OR n.name = ? COLLATE NOCASE OR n.name LIKE ? ESCAPE '\\')
       AND n.id NOT IN (SELECT value FROM json_each(?))`,
  ).all(parentId, kind, name, `${stem}${ext}`, `${likeEscape(stem)} (%)${likeEscape(ext)}`, JSON.stringify(exclude)) as Sibling[];
}

/** The first free name in a folder: `name`, else "stem (1).ext", "stem (2).ext"… */
export function uniqueName(parentId: string, name: string, kind: NodeKind, exclude: string[] = []): string {
  const taken = new Set(nameFamily(parentId, name, kind, exclude).map((s) => s.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  const [base, ext] = splitName(name, kind);
  const stem = stemOf(base).slice(0, 240 - ext.length);
  for (let i = 1; ; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

function clashes(parentId: string | null, name: string, kind: NodeKind, exceptId: string): boolean {
  if (!parentId) return false;
  return !!sql("SELECT 1 FROM nodes WHERE parent_id = ? AND kind = ? AND in_trash = 0 AND name = ? COLLATE NOCASE AND id <> ? LIMIT 1").get(
    parentId,
    kind,
    name,
    exceptId,
  );
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function getNode(id: string): DriveNode | null {
  const row = sql(`SELECT ${COLS} FROM nodes n WHERE n.id = ?`).get(id) as Row | undefined;
  return row ? toNode(row) : null;
}

export function requireNode(id: string): DriveNode {
  const node = getNode(id);
  if (!node) throw notFound("File or folder not found");
  return node;
}

function requireFolder(id: string): DriveNode {
  const node = requireNode(id);
  if (node.kind !== "folder") throw badRequest("Target is not a folder");
  if (sql("SELECT in_trash FROM nodes WHERE id = ?").pluck().get(id) === 1) throw badRequest("Folder is in the trash");
  return node;
}

export function breadcrumbs(id: string): Crumb[] {
  return sql(
    `WITH RECURSIVE chain(id, parent_id, name, depth) AS (
       SELECT id, parent_id, name, 0 FROM nodes WHERE id = ?
       UNION ALL SELECT n.id, n.parent_id, n.name, c.depth + 1 FROM nodes n JOIN chain c ON n.id = c.parent_id
     ) SELECT id, name FROM chain ORDER BY depth DESC`,
  ).all(id) as Crumb[];
}

/** True if `ancestorId` is `id` itself or one of its ancestors. */
export function isWithin(id: string, ancestorId: string): boolean {
  return breadcrumbs(id).some((c) => c.id === ancestorId);
}

export function listChildren(parentId: string, foldersOnly = false): DriveNode[] {
  return toNodes(
    sql(
      `SELECT ${COLS} FROM nodes n WHERE n.parent_id = ? AND n.in_trash = 0 ${foldersOnly ? "AND n.kind = 'folder'" : ""}
       ORDER BY n.kind DESC, n.name COLLATE NOCASE`,
    ).all(parentId),
  );
}

export function folderListing(id: string, foldersOnly = false): FolderListing {
  const folder = requireNode(id);
  if (folder.kind !== "folder") throw badRequest("Not a folder");
  return { folder, path: breadcrumbs(id), items: listChildren(id, foldersOnly) };
}

export function listRecent(limit = 200): DriveNode[] {
  return toNodes(
    sql(`SELECT ${COLS} FROM nodes n WHERE n.kind = 'file' AND n.in_trash = 0 ORDER BY n.touched_at DESC LIMIT ?`).all(limit),
  );
}

export function listStarred(): DriveNode[] {
  return toNodes(
    sql(`SELECT ${COLS} FROM nodes n WHERE n.starred = 1 AND n.in_trash = 0 ORDER BY n.kind DESC, n.name COLLATE NOCASE`).all(),
  );
}

export function listTrash(): DriveNode[] {
  return toNodes(sql(`SELECT ${COLS} FROM nodes n WHERE n.trashed_at IS NOT NULL ORDER BY n.trashed_at DESC`).all());
}

/** Folders with the freshest activity: the parents of recently touched files, then recently changed folders. */
export function listRecentFolders(limit = 8): DriveNode[] {
  return toNodes(
    sql(
      `WITH ranked AS (
         SELECT parent_id AS id, MAX(touched_at) AS at FROM nodes
         WHERE kind = 'file' AND in_trash = 0 AND parent_id IS NOT NULL AND parent_id <> 'root' GROUP BY parent_id
         UNION ALL
         SELECT id, updated_at FROM nodes WHERE kind = 'folder' AND in_trash = 0 AND id <> 'root'
       )
       SELECT ${COLS} FROM (SELECT id, MAX(at) AS at FROM ranked GROUP BY id) r
       JOIN nodes n ON n.id = r.id WHERE n.in_trash = 0 ORDER BY r.at DESC LIMIT ?`,
    ).all(limit),
  );
}

export function listStarredFolders(limit = 8): DriveNode[] {
  return toNodes(
    sql(`SELECT ${COLS} FROM nodes n WHERE n.kind = 'folder' AND n.starred = 1 AND n.in_trash = 0 ORDER BY n.updated_at DESC LIMIT ?`).all(limit),
  );
}

export function listSharedFolders(limit = 8): DriveNode[] {
  return toNodes(
    sql(
      `SELECT ${COLS} FROM nodes n WHERE n.kind = 'folder' AND n.in_trash = 0 AND n.id IN (
         SELECT si.node_id FROM share_items si JOIN shares s ON s.id = si.share_id
         WHERE s.expires_at IS NULL OR s.expires_at > unixepoch() * 1000
       ) ORDER BY n.updated_at DESC LIMIT ?`,
    ).all(limit),
  );
}

/** Substring search: FTS5 trigram index for ≥3 chars, LIKE scan otherwise. */
export function search(query: string, limit = 200): DriveNode[] {
  const q = query.trim();
  if (!q) return [];
  if ([...q].length >= 3) {
    const match = `"${q.replace(/"/g, '""')}"`;
    return toNodes(
      sql(
        `SELECT ${COLS} FROM nodes_fts f JOIN nodes n ON n.rid = f.rowid
         WHERE nodes_fts MATCH ? AND n.in_trash = 0 AND n.id <> 'root'
         ORDER BY n.kind DESC, length(n.name), n.touched_at DESC LIMIT ?`,
      ).all(match, limit),
    );
  }
  const like = `%${likeEscape(q)}%`;
  return toNodes(
    sql(
      `SELECT ${COLS} FROM nodes n WHERE n.name LIKE ? ESCAPE '\\' AND n.in_trash = 0 AND n.id <> 'root'
       ORDER BY n.kind DESC, length(n.name) LIMIT ?`,
    ).all(like, limit),
  );
}

const nameOf = (id: string) => sql("SELECT name FROM nodes WHERE id = ?").pluck().get(id) as string | undefined;

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export function createFolder(parentId: string, rawName: unknown): DriveNode {
  requireFolder(parentId);
  const id = newId();
  const now = Date.now();
  tx(() => {
    const name = uniqueName(parentId, cleanName(rawName), "folder");
    sql(
      `INSERT INTO nodes (id, parent_id, kind, name, created_at, updated_at, touched_at) VALUES (?, ?, 'folder', ?, ?, ?, ?)`,
    ).run(id, parentId, name, now, now, now);
    logActivity({ kind: "folder", name, nodeId: id, parentId });
  });
  emitNodes("create", { parents: [parentId], ids: [id] });
  return getNode(id)!;
}

/**
 * Creates a folder hierarchy in one transaction (folder uploads). Folders that
 * already exist are reused, so uploading a folder again merges into it instead
 * of creating a second one with the same name. Returns path → folder id.
 */
export function mkdirp(parentId: string, paths: string[]): Record<string, string> {
  requireFolder(parentId);
  const result: Record<string, string> = {};
  const created: string[] = [];
  const now = Date.now();
  const insert = sql(
    `INSERT INTO nodes (id, parent_id, kind, name, created_at, updated_at, touched_at) VALUES (?, ?, 'folder', ?, ?, ?, ?)`,
  );
  const existing = sql(
    "SELECT id FROM nodes WHERE parent_id = ? AND kind = 'folder' AND in_trash = 0 AND name = ? COLLATE NOCASE ORDER BY created_at LIMIT 1",
  ).pluck();
  tx(() => {
    const sorted = [...new Set(paths)].sort((a, b) => a.split("/").length - b.split("/").length);
    for (const p of sorted) {
      const segments = p.split("/").filter(Boolean).map(cleanName);
      let parent = parentId;
      let acc = "";
      for (const seg of segments) {
        acc = acc ? `${acc}/${seg}` : seg;
        if (!result[acc]) {
          const found = existing.get(parent, seg) as string | undefined;
          if (found) result[acc] = found;
          else {
            const id = newId();
            insert.run(id, parent, seg, now, now, now);
            result[acc] = id;
            created.push(id);
          }
        }
        parent = result[acc];
      }
    }
  });
  if (created.length) emitNodes("create", { parents: [parentId], ids: created });
  return result;
}

/** Which of these relative paths ("Photos/a.jpg") already exist as files under `parentId`. */
export function findConflicts(parentId: string, paths: string[]): { path: string; id: string; name: string; size: number; updatedAt: number }[] {
  requireFolder(parentId);
  const folder = sql("SELECT id FROM nodes WHERE parent_id = ? AND kind = 'folder' AND in_trash = 0 AND name = ? COLLATE NOCASE LIMIT 1").pluck();
  const file = sql("SELECT id, name, size, updated_at AS updatedAt FROM nodes WHERE parent_id = ? AND kind = 'file' AND in_trash = 0 AND name = ? COLLATE NOCASE LIMIT 1");
  const dirs = new Map<string, string | null>([["", parentId]]);
  const resolveDir = (dir: string): string | null => {
    if (dirs.has(dir)) return dirs.get(dir)!;
    const cut = dir.lastIndexOf("/");
    const up = resolveDir(cut < 0 ? "" : dir.slice(0, cut));
    const id = up ? ((folder.get(up, dir.slice(cut + 1)) as string | undefined) ?? null) : null;
    dirs.set(dir, id);
    return id;
  };
  const out: { path: string; id: string; name: string; size: number; updatedAt: number }[] = [];
  for (const raw of paths.slice(0, 20_000)) {
    if (typeof raw !== "string") continue;
    const segs = raw.split("/").filter(Boolean);
    if (!segs.length) continue;
    const dir = resolveDir(segs.slice(0, -1).join("/"));
    if (!dir) continue;
    const hit = file.get(dir, segs.at(-1)) as { id: string; name: string; size: number; updatedAt: number } | undefined;
    if (hit) out.push({ path: raw, ...hit });
  }
  return out;
}

/**
 * Places a freshly uploaded file (call inside a transaction):
 *  - the very same bytes already sit here under this name (or a numbered
 *    variant of it) → nothing new is created, the existing file is returned;
 *  - a different file has the name → keep both ("name (1).ext"), or replace
 *    it, in which case the old file goes to the trash and stays restorable.
 */
export function placeUpload(input: {
  parentId: string;
  name: string;
  size: number;
  mime: string | null;
  blobId: string;
  sha256: string | null;
  policy: ConflictPolicy;
  /** When the photo/video was taken, if its metadata says. */
  takenAt?: number | null;
  /** Runs right before a new node is inserted (e.g. to insert its blob first); skipped for identical files. */
  onCreate?: () => void;
}): { node: DriveNode; outcome: UploadOutcome; replaced?: string; purged?: string[] } {
  const parentOk = sql("SELECT 1 FROM nodes WHERE id = ? AND kind = 'folder' AND in_trash = 0").get(input.parentId);
  const parentId = parentOk ? input.parentId : ROOT_ID;
  const name = cleanName(input.name);
  const family = nameFamily(parentId, name, "file");
  const same = family.find((s) => s.size === input.size && (s.blobId === input.blobId || (input.sha256 !== null && s.sha256 === input.sha256)));
  if (same) return { node: getNode(same.id)!, outcome: "identical" };

  const clash = family.find((s) => s.name.toLowerCase() === name.toLowerCase());
  const now = Date.now();
  if (clash && input.policy === "replace") {
    // A new version: the file keeps its identity (links, star, place) and its
    // previous content moves into its version history.
    input.onCreate?.();
    const purged = saveAsNewVersion(clash.id, { blobId: input.blobId, size: input.size, mime: input.mime, takenAt: input.takenAt ?? null }, now);
    return { node: getNode(clash.id)!, outcome: "replaced", purged };
  }
  let finalName = name;
  let outcome: UploadOutcome = "created";
  if (clash) {
    finalName = uniqueName(parentId, name, "file");
    outcome = "renamed";
  }
  input.onCreate?.();
  const id = newId();
  sql(
    `INSERT INTO nodes (id, parent_id, kind, name, size, mime, blob_id, taken_at, created_at, updated_at, touched_at)
     VALUES (?, ?, 'file', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, parentId, finalName, input.size, input.mime, input.blobId, input.takenAt ?? null, now, now, now);
  return { node: getNode(id)!, outcome };
}

// ---------------------------------------------------------------------------
// Version history
// ---------------------------------------------------------------------------

/**
 * Makes `content` the file's current content and keeps the previous one as a
 * version. Runs inside the caller's transaction. Returns blobs that pruning
 * old versions left unreferenced (already queued for removal from storage).
 */
function saveAsNewVersion(nodeId: string, content: { blobId: string; size: number; mime: string | null; takenAt: number | null }, now: number): string[] {
  const cur = sql("SELECT blob_id AS blobId, size, mime, taken_at AS takenAt FROM nodes WHERE id = ? AND kind = 'file'").get(nodeId) as
    | { blobId: string | null; size: number; mime: string | null; takenAt: number | null }
    | undefined;
  if (!cur) throw notFound("File not found");
  if (cur.blobId && cur.blobId !== content.blobId) {
    const uploadedAt = (sql("SELECT created_at FROM blobs WHERE id = ?").pluck().get(cur.blobId) as number | undefined) ?? now;
    sql("INSERT INTO versions (id, node_id, blob_id, size, mime, taken_at, created_at, replaced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      newId(),
      nodeId,
      cur.blobId,
      cur.size,
      cur.mime,
      cur.takenAt,
      Math.min(uploadedAt, now),
      now,
    );
  }
  sql("UPDATE nodes SET blob_id = ?, size = ?, mime = ?, taken_at = ?, updated_at = ?, touched_at = ? WHERE id = ?").run(
    content.blobId,
    content.size,
    content.mime,
    content.takenAt,
    now,
    now,
    nodeId,
  );
  return pruneVersions(nodeId);
}

/** Keeps the newest VERSIONS_KEEP versions of a file; older ones (and their storage, if unshared) go. */
function pruneVersions(nodeId: string): string[] {
  const keep = config().versionsKeep;
  const old = sql("SELECT id, blob_id AS blobId FROM versions WHERE node_id = ? ORDER BY replaced_at DESC LIMIT -1 OFFSET ?").all(nodeId, keep) as {
    id: string;
    blobId: string;
  }[];
  if (!old.length) return [];
  const del = sql("DELETE FROM versions WHERE id = ?");
  for (const v of old) del.run(v.id);
  return purgeOrphanBlobs([...new Set(old.map((v) => v.blobId))]);
}

export function listVersions(nodeId: string): FileVersion[] {
  requireNode(nodeId);
  return sql(
    "SELECT id, size, mime, created_at AS createdAt, replaced_at AS replacedAt FROM versions WHERE node_id = ? ORDER BY replaced_at DESC, created_at DESC",
  ).all(nodeId) as FileVersion[];
}

/** A version's content, for downloading it. */
export function versionContent(nodeId: string, versionId: string): { blobId: string; size: number; mime: string | null; takenAt: number | null } {
  const v = sql("SELECT blob_id AS blobId, size, mime, taken_at AS takenAt FROM versions WHERE id = ? AND node_id = ?").get(versionId, nodeId) as
    | { blobId: string; size: number; mime: string | null; takenAt: number | null }
    | undefined;
  if (!v) throw notFound("That version no longer exists");
  return v;
}

/** Makes an earlier version current again; the content it replaces becomes a version itself. */
export function restoreVersion(nodeId: string, versionId: string): { node: DriveNode; purged: string[] } {
  const result = tx(() => {
    const v = versionContent(nodeId, versionId);
    sql("DELETE FROM versions WHERE id = ?").run(versionId);
    const purged = saveAsNewVersion(nodeId, v, Date.now());
    const node = getNode(nodeId)!;
    logActivity({ kind: "version", name: node.name, nodeId, parentId: node.parentId, detail: { restored: versionId } });
    return { node, purged };
  });
  emitNodes("version", { parents: [result.node.parentId], ids: [nodeId] });
  return result;
}

/** Deletes one earlier version (its storage goes too, unless other files share it). */
export function deleteVersion(nodeId: string, versionId: string): string[] {
  const purged = tx(() => {
    const v = versionContent(nodeId, versionId);
    sql("DELETE FROM versions WHERE id = ?").run(versionId);
    return purgeOrphanBlobs([v.blobId]);
  });
  const node = getNode(nodeId);
  emitNodes("version", { parents: [node?.parentId ?? null], ids: [nodeId] });
  return purged;
}

/** A live file with this exact name (case-insensitive) in the folder, if any. */
export function fileNamed(parentId: string, name: string): DriveNode | null {
  const id = sql("SELECT id FROM nodes WHERE parent_id = ? AND kind = 'file' AND in_trash = 0 AND name = ? COLLATE NOCASE LIMIT 1")
    .pluck()
    .get(parentId, name) as string | undefined;
  return id ? getNode(id) : null;
}

export function rename(id: string, rawName: unknown): DriveNode {
  if (id === ROOT_ID) throw badRequest("Cannot rename the root folder");
  const before = requireNode(id);
  const name = cleanName(rawName);
  const live = sql("SELECT in_trash FROM nodes WHERE id = ?").pluck().get(id) === 0;
  if (live && clashes(before.parentId, name, before.kind, id)) {
    throw conflict(`There's already ${before.kind === "folder" ? "a folder" : "a file"} named “${name}” here`);
  }
  tx(() => {
    sql("UPDATE nodes SET name = ?, updated_at = ? WHERE id = ?").run(name, Date.now(), id);
    if (name !== before.name) logActivity({ kind: "rename", name, nodeId: id, parentId: before.parentId, detail: { from: before.name } });
  });
  const node = getNode(id)!;
  emitNodes("rename", { parents: [node.parentId], ids: [id] });
  return node;
}

export function setStarred(ids: string[], starred: boolean) {
  sql("UPDATE nodes SET starred = ? WHERE id IN (SELECT value FROM json_each(?)) AND id <> 'root'").run(
    starred ? 1 : 0,
    JSON.stringify(ids),
  );
  emitNodes("star", { parents: parentsOf(ids), ids });
}

/** Gives folders a colour from the palette (null = default). */
export function setColor(ids: string[], color: unknown) {
  if (color !== null && !FOLDER_COLORS.includes(color as FolderColor)) throw badRequest("Unknown colour");
  sql("UPDATE nodes SET color = ? WHERE id IN (SELECT value FROM json_each(?)) AND kind = 'folder' AND id <> 'root'").run(color, JSON.stringify(ids));
  emitNodes("color", { parents: parentsOf(ids), ids });
}

export function touch(id: string) {
  sql("UPDATE nodes SET touched_at = ? WHERE id = ?").run(Date.now(), id);
}

/** Moves live items; any that would collide with a name in the target get a numbered name. */
export function move(ids: string[], targetId: string): { renamed: number } {
  requireFolder(targetId);
  const targetChain = new Set(breadcrumbs(targetId).map((c) => c.id));
  for (const id of ids) {
    if (id === ROOT_ID) throw badRequest("Cannot move the root folder");
    if (targetChain.has(id)) throw conflict("Cannot move a folder into itself or one of its subfolders");
  }
  const from = parentsOf(ids);
  const now = Date.now();
  const renamed = tx(() => {
    // Only live items move: a trashed item keeps its place so restore stays coherent.
    const rows = sql("SELECT id, name, kind, parent_id AS parentId FROM nodes WHERE id IN (SELECT value FROM json_each(?)) AND id <> 'root' AND in_trash = 0").all(
      JSON.stringify(ids),
    ) as { id: string; name: string; kind: NodeKind; parentId: string }[];
    const update = sql("UPDATE nodes SET parent_id = ?, name = ?, updated_at = ? WHERE id = ?");
    let count = 0;
    let moved = 0;
    for (const r of rows) {
      if (r.parentId === targetId) continue;
      const name = uniqueName(targetId, r.name, r.kind, [r.id]);
      update.run(targetId, name, now, r.id);
      moved++;
      if (name !== r.name) count++;
    }
    if (moved) logActivity({ kind: "move", name: rows[0]?.name, nodeId: rows[0]?.id, parentId: targetId, count: moved });
    return count;
  });
  emitNodes("move", { parents: [...from, targetId], ids });
  return { renamed };
}

/** Deep copy. Content is shared via blob references, so copying terabytes is instant. */
export function copy(ids: string[], targetId: string): DriveNode[] {
  requireFolder(targetId);
  const targetChain = new Set(breadcrumbs(targetId).map((c) => c.id));
  const now = Date.now();
  const insert = sql(
    `INSERT INTO nodes (id, parent_id, kind, name, size, mime, blob_id, created_at, updated_at, touched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const children = sql(`SELECT ${COLS} FROM nodes n WHERE n.parent_id = ? AND n.in_trash = 0`);
  const copyOne = (src: DriveNode, parent: string, name: string): string => {
    const id = newId();
    insert.run(id, parent, src.kind, name, src.size, src.mime, src.blobId, now, now, now);
    if (src.kind === "folder") {
      for (const child of toNodes(children.all(src.id))) copyOne(child, id, child.name);
    }
    return id;
  };
  const created = tx(() => {
    const out = ids.map((id) => {
      const src = requireNode(id);
      if (id === ROOT_ID) throw badRequest("Cannot copy the root folder");
      if (src.kind === "folder" && targetChain.has(id)) throw conflict("Cannot copy a folder into itself");
      return getNode(copyOne(src, targetId, uniqueName(targetId, src.name, src.kind)))!;
    });
    if (out.length) logActivity({ kind: "copy", name: out[0].name, nodeId: out[0].id, parentId: targetId, count: out.length });
    return out;
  });
  emitNodes("copy", { parents: [targetId], ids: created.map((n) => n.id) });
  return created;
}

export function trash(ids: string[]) {
  const live = ids.filter((id) => id !== ROOT_ID);
  const json = JSON.stringify(live);
  tx(() => {
    const first = live.length ? nameOf(live[0]) : undefined;
    const changed = sql("UPDATE nodes SET trashed_at = ? WHERE id IN (SELECT value FROM json_each(?)) AND trashed_at IS NULL").run(Date.now(), json).changes;
    sql(`${SUBTREE} UPDATE nodes SET in_trash = 1 WHERE id IN (SELECT id FROM sub)`).run(json);
    if (changed) logActivity({ kind: "trash", name: first, nodeId: live[0], count: changed });
  });
  emitNodes("trash", { parents: parentsOf(ids), ids, removed: ids });
}

export function restore(ids: string[]) {
  const json = JSON.stringify(ids);
  tx(() => {
    // If the original parent is gone or still in the trash, restore into the root.
    sql(
      `UPDATE nodes SET trashed_at = NULL, parent_id = CASE
         WHEN EXISTS (SELECT 1 FROM nodes p WHERE p.id = nodes.parent_id AND p.in_trash = 0) THEN parent_id ELSE 'root' END
       WHERE id IN (SELECT value FROM json_each(?)) AND id <> 'root'`,
    ).run(json);
    // Un-trash the subtrees, but leave descendants that were trashed individually.
    sql(
      `WITH RECURSIVE sub(id) AS (
         SELECT value FROM json_each(?)
         UNION SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id WHERE n.trashed_at IS NULL
       ) UPDATE nodes SET in_trash = 0 WHERE id IN (SELECT id FROM sub)`,
    ).run(json);
    // Something new may have taken the name in the meantime.
    const rows = sql("SELECT id, name, kind, parent_id AS parentId FROM nodes WHERE id IN (SELECT value FROM json_each(?)) AND in_trash = 0").all(json) as {
      id: string;
      name: string;
      kind: NodeKind;
      parentId: string;
    }[];
    const setName = sql("UPDATE nodes SET name = ? WHERE id = ?");
    for (const r of rows) if (clashes(r.parentId, r.name, r.kind, r.id)) setName.run(uniqueName(r.parentId, r.name, r.kind, [r.id]), r.id);
    if (rows.length) logActivity({ kind: "restore", name: rows[0].name, nodeId: rows[0].id, parentId: rows[0].parentId, count: rows.length });
  });
  emitNodes("restore", { parents: parentsOf(ids), ids });
}

/**
 * Permanently deletes nodes and their subtrees. Blobs that are no longer
 * referenced by any node are removed and their storage parts queued for GC.
 */
export function deleteForever(ids: string[], reason: "delete" | "purge" = "delete"): string[] {
  const live = ids.filter((id) => id !== ROOT_ID);
  const json = JSON.stringify(live);
  const parents = parentsOf(ids);
  const purged = tx(() => {
    const first = live.length ? nameOf(live[0]) : undefined;
    // Current contents and every kept version: the versions go with their file.
    const blobIds = sql(
      `${SUBTREE} SELECT DISTINCT blob_id FROM nodes WHERE id IN (SELECT id FROM sub) AND blob_id IS NOT NULL
       UNION SELECT blob_id FROM versions WHERE node_id IN (SELECT id FROM sub)`,
    )
      .pluck()
      .all(json) as string[];
    const removed = sql("DELETE FROM nodes WHERE id IN (SELECT value FROM json_each(?))").run(json).changes;
    // Links whose every item is gone are gone too.
    sql("DELETE FROM shares WHERE NOT EXISTS (SELECT 1 FROM share_items si WHERE si.share_id = shares.id)").run();
    if (removed) logActivity({ kind: reason, name: first, count: removed });
    return purgeOrphanBlobs(blobIds);
  });
  emitNodes(reason, { parents, ids, removed: ids });
  return purged;
}

/** Trash retention: permanently deletes items trashed more than `days` ago. */
export function purgeExpiredTrash(days: number): { nodes: number; blobs: string[] } {
  if (days <= 0) return { nodes: 0, blobs: [] };
  const ids = sql("SELECT id FROM nodes WHERE trashed_at IS NOT NULL AND trashed_at < ?").pluck().all(Date.now() - days * 86_400_000) as string[];
  return ids.length ? { nodes: ids.length, blobs: deleteForever(ids, "purge") } : { nodes: 0, blobs: [] };
}

export function emptyTrash(): string[] {
  const ids = sql("SELECT id FROM nodes WHERE trashed_at IS NOT NULL").pluck().all() as string[];
  return ids.length ? deleteForever(ids) : [];
}

function purgeOrphanBlobs(blobIds: string[]): string[] {
  const purged: string[] = [];
  const now = Date.now();
  for (const blobId of blobIds) {
    // Still in use: by a file, or kept as an earlier version of one.
    if (sql("SELECT 1 FROM nodes WHERE blob_id = ? LIMIT 1").get(blobId)) continue;
    if (sql("SELECT 1 FROM versions WHERE blob_id = ? LIMIT 1").get(blobId)) continue;
    const blob = sql("SELECT driver FROM blobs WHERE id = ?").get(blobId) as { driver: string } | undefined;
    if (!blob) continue;
    sql(
      `INSERT INTO gc_queue (driver, blob_id, ref, next_at) SELECT ?, blob_id, ref, ? FROM blob_parts WHERE blob_id = ?`,
    ).run(blob.driver, now, blobId);
    sql("DELETE FROM blobs WHERE id = ?").run(blobId);
    forgetBlobMeta(blobId);
    purged.push(blobId);
  }
  return purged;
}

/** Flattens a selection into zip entries with relative paths. */
export function collectForArchive(ids: string[]): { path: string; node: DriveNode }[] {
  const out: { path: string; node: DriveNode }[] = [];
  const children = sql(`SELECT ${COLS} FROM nodes n WHERE n.parent_id = ? AND n.in_trash = 0 ORDER BY n.name`);
  const walk = (node: DriveNode, prefix: string) => {
    const path = prefix ? `${prefix}/${node.name}` : node.name;
    out.push({ path, node });
    if (node.kind === "folder") for (const c of toNodes(children.all(node.id))) walk(c, path);
  };
  for (const id of ids) {
    const node = requireNode(id);
    if (node.id === ROOT_ID) {
      for (const c of listChildren(ROOT_ID)) walk(c, "");
    } else {
      walk(node, "");
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Photos and storage insights
// ---------------------------------------------------------------------------

const PHOTO_WHERE = "n.kind = 'file' AND n.in_trash = 0 AND (n.mime LIKE 'image/%' OR n.mime LIKE 'video/%')";

/**
 * Every photo and video, newest moment first (when it was taken, else when
 * it was uploaded), a page at a time. `ratio` (width ÷ height, from the
 * thumbnail) lets the timeline lay out justified rows before anything loads.
 */
export function listPhotos(cursor: string | null, limit = 600): { items: (DriveNode & { ratio: number | null; at: number })[]; next: string | null } {
  const lim = Math.max(1, Math.min(2000, limit));
  let after = "";
  const params: unknown[] = [];
  const m = cursor ? /^(\d+):([A-Za-z0-9_-]+)$/.exec(cursor) : null;
  if (m) {
    after = "AND (COALESCE(n.taken_at, n.created_at) < ? OR (COALESCE(n.taken_at, n.created_at) = ? AND n.id < ?))";
    params.push(Number(m[1]), Number(m[1]), m[2]);
  }
  const rows = sql(
    `SELECT ${COLS}, COALESCE(n.taken_at, n.created_at) AS at,
       (SELECT CAST(t.width AS REAL) / t.height FROM thumbs t WHERE t.blob_id = n.blob_id AND t.height > 0) AS ratio
     FROM nodes n WHERE ${PHOTO_WHERE} ${after}
     ORDER BY COALESCE(n.taken_at, n.created_at) DESC, n.id DESC LIMIT ?`,
  ).all(...params, lim + 1) as (Row & { ratio: number | null; at: number })[];
  const page = rows.slice(0, lim).map((r) => ({ ...toNode(r), ratio: r.ratio, at: r.at }));
  const last = page.at(-1);
  return { items: page, next: rows.length > lim && last ? `${last.at}:${last.id}` : null };
}

/** Where the space goes: the biggest files, by type, earlier versions and the trash. */
export function storageInsights() {
  const largest = toNodes(sql(`SELECT ${COLS} FROM nodes n WHERE n.kind = 'file' AND n.in_trash = 0 ORDER BY n.size DESC LIMIT 50`).all());
  const versions = sql("SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM versions").get() as { count: number; bytes: number };
  const trash = sql("SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM nodes WHERE kind = 'file' AND in_trash = 1").get() as { count: number; bytes: number };
  const live = sql("SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM nodes WHERE kind = 'file' AND in_trash = 0").get() as { count: number; bytes: number };
  const stored = sql("SELECT COALESCE(SUM(size), 0) FROM blobs").pluck().get() as number;
  const byYear = sql(
    `SELECT CAST(strftime('%Y', COALESCE(taken_at, created_at) / 1000, 'unixepoch') AS INTEGER) AS year, COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes
     FROM nodes n WHERE ${PHOTO_WHERE} GROUP BY 1 ORDER BY 1 DESC LIMIT 30`,
  ).all() as { year: number; count: number; bytes: number }[];
  return { largest, versions, trash, live, stored, photosByYear: byYear };
}

/** Counts for the home screen. */
export function driveStats() {
  return sql(
    `SELECT
       (SELECT COUNT(*) FROM nodes WHERE kind = 'file' AND in_trash = 0) AS files,
       (SELECT COUNT(*) FROM nodes WHERE kind = 'folder' AND in_trash = 0 AND id <> 'root') AS folders,
       (SELECT COALESCE(SUM(size), 0) FROM nodes WHERE kind = 'file' AND in_trash = 0) AS bytes,
       (SELECT COUNT(*) FROM shares WHERE expires_at IS NULL OR expires_at > unixepoch() * 1000) AS shares`,
  ).get() as { files: number; folders: number; bytes: number; shares: number };
}
