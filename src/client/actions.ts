"use client";
import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { BatchOp, DriveNode, FolderColor, FolderListing, HomeData, PhotosPage, Share, ShareOptions, StorageInsights, ViewListing } from "@/lib/types";
import { ApiError, api, apiRetry, copyText, del, downloadUrl, patch, randomKey } from "./api";
import { fastDownload } from "./download/engine";
import { fileUrl } from "./files";
import { LISTING_KEYS, qk } from "./queries";
import { useUi } from "./store";
import { bindSync, confirmRemoval, invalidate, mutate } from "./sync";

let qc: QueryClient | null = null;

/** Wires mutations and the live change feed to the QueryClient. */
export function bindQueryClient(client: QueryClient) {
  qc = client;
  bindSync(client);
}

/** Refetch every listing (used after bulk operations like uploads). */
export function invalidateDrive() {
  invalidate("all");
}

type Listing = FolderListing | ViewListing | HomeData | StorageInsights | InfiniteData<PhotosPage>;

/** Applies a transformation to every cached listing (folders, views, home). Returns a rollback. */
function patchListings(fn: (items: DriveNode[], key: readonly unknown[]) => DriveNode[]): () => void {
  if (!qc) return () => {};
  const snapshots: [readonly unknown[], unknown][] = [];
  for (const q of qc.getQueryCache().findAll({ predicate: (q) => LISTING_KEYS.has(String(q.queryKey[0])) })) {
    const data = q.state.data as Listing | undefined;
    if (!data) continue;
    if ("items" in data) {
      snapshots.push([q.queryKey, data]);
      qc.setQueryData(q.queryKey, { ...data, items: fn(data.items, q.queryKey) });
    } else if ("pages" in data) {
      // Paged lists (the photo timeline).
      snapshots.push([q.queryKey, data]);
      qc.setQueryData<InfiniteData<PhotosPage>>(q.queryKey, {
        ...data,
        pages: data.pages.map((p) => ({ ...p, items: fn(p.items, q.queryKey) as PhotosPage["items"] })),
      });
    } else if ("largest" in data) {
      snapshots.push([q.queryKey, data]);
      qc.setQueryData<StorageInsights>(q.queryKey, { ...data, largest: fn(data.largest, q.queryKey) });
    } else if ("recentFiles" in data) {
      snapshots.push([q.queryKey, data]);
      const k = ["home"] as const;
      qc.setQueryData<HomeData>(q.queryKey, {
        ...data,
        recentFiles: fn(data.recentFiles, k),
        folders: { recent: fn(data.folders.recent, k), starred: fn(data.folders.starred, k), shared: fn(data.folders.shared, k) },
      });
    }
  }
  return () => snapshots.forEach(([k, d]) => qc?.setQueryData(k, d));
}

const idsOf = (nodes: DriveNode[]) => nodes.map((n) => n.id);
const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
const label = (nodes: DriveNode[]) => (nodes.length === 1 ? `“${nodes[0].name}”` : plural(nodes.length, "item"));
const isView = (key: readonly unknown[], view: string) => key[0] === "view" && key[1] === view;

function fail(e: unknown) {
  toast.error(e instanceof ApiError ? e.message : "Something went wrong — nothing was changed");
}

/**
 * POST /api/nodes/batch with automatic retries. One idempotency key per user
 * action: if a response is lost and the request is re-sent, the server replays
 * the first outcome instead of applying the operation twice.
 */
function batch<T = { ok?: boolean; nodes?: DriveNode[]; purgedBlobs?: number; blobs?: string[]; queuedParts?: number; renamed?: number }>(op: BatchOp) {
  return apiRetry<T>("/api/nodes/batch", { method: "POST", json: op, idempotencyKey: randomKey("op"), attempts: 5 });
}

export async function createFolder(parentId: string, name: string): Promise<DriveNode | null> {
  try {
    return await mutate({
      request: async () => {
        const { node } = await apiRetry<{ node: DriveNode }>("/api/nodes", { method: "POST", json: { parentId, name }, idempotencyKey: randomKey("mk"), attempts: 5 });
        qc?.setQueryData<FolderListing>(qk.folder(parentId), (old) => (old ? { ...old, items: [node, ...old.items.filter((n) => n.id !== node.id)] } : old));
        if (node.name !== name.trim()) toast(`Named “${node.name}” — “${name.trim()}” was taken`);
        return node;
      },
      invalidate: [qk.folder(parentId), qk.folders(parentId), qk.home],
    });
  } catch (e) {
    fail(e);
    return null;
  }
}

/** Renames optimistically; a name clash comes back as an error the dialog can show. */
export async function renameNode(node: DriveNode, name: string): Promise<string | null> {
  try {
    await mutate({
      optimistic: () => patchListings((items) => items.map((n) => (n.id === node.id ? { ...n, name } : n))),
      request: () => api(`/api/nodes/${node.id}`, { method: "PATCH", json: { name } }),
    });
    return null;
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) return e.message;
    fail(e);
    return null;
  }
}

export async function setStarred(nodes: DriveNode[], starred: boolean) {
  const ids = new Set(idsOf(nodes));
  try {
    await mutate({
      optimistic: () =>
        patchListings((items, key) => {
          const next = items.map((n) => (ids.has(n.id) ? { ...n, starred } : n));
          if (!isView(key, "starred")) return next;
          return starred
            ? [...next, ...nodes.filter((n) => !items.some((i) => i.id === n.id)).map((n) => ({ ...n, starred }))]
            : next.filter((n) => !ids.has(n.id));
        }),
      request: () => batch({ op: "star", ids: [...ids], starred }),
    });
  } catch (e) {
    fail(e);
  }
}

/** Soft delete: the item waits in the trash (restorable) until it is emptied. */
export async function trashNodes(nodes: DriveNode[]) {
  if (!nodes.length) return;
  const ids = new Set(idsOf(nodes));
  useUi.getState().clearSelection();
  const ui = useUi.getState();
  if (ui.preview && ids.has(ui.preview.id)) ui.closePreview();
  try {
    await mutate({
      optimistic: () =>
        patchListings((items, key) =>
          isView(key, "trash") ? [...nodes.map((n) => ({ ...n, trashedAt: Date.now() })), ...items.filter((n) => !ids.has(n.id))] : items.filter((n) => !ids.has(n.id)),
        ),
      request: () => batch({ op: "trash", ids: [...ids] }),
    });
    toast(`${label(nodes)} moved to trash`, {
      action: { label: "Undo", onClick: () => void restoreNodes(nodes, true) },
    });
  } catch (e) {
    fail(e);
  }
}

export async function restoreNodes(nodes: DriveNode[], quiet = false) {
  const ids = new Set(idsOf(nodes));
  try {
    await mutate({
      optimistic: () =>
        patchListings((items, key) =>
          isView(key, "trash")
            ? items.filter((n) => !ids.has(n.id))
            : key[0] === "folder" && nodes.some((n) => n.parentId === key[1])
              ? [...items, ...nodes.filter((n) => n.parentId === key[1] && !items.some((i) => i.id === n.id)).map((n) => ({ ...n, trashedAt: null }))]
              : items,
        ),
      request: () => batch({ op: "restore", ids: [...ids] }),
    });
    if (!quiet) toast(`${label(nodes)} restored`);
  } catch (e) {
    fail(e);
  }
}

/** Permanent delete: gone from the index now, gone from Telegram seconds later (confirmed live). */
export async function deleteForever(nodes: DriveNode[]) {
  if (!nodes.length) return;
  const ids = new Set(idsOf(nodes));
  useUi.getState().clearSelection();
  const ui = useUi.getState();
  if (ui.preview && ids.has(ui.preview.id)) ui.closePreview();
  const toastId = toast.loading(`Deleting ${label(nodes)}…`);
  try {
    const res = await mutate({
      optimistic: () => patchListings((items) => items.filter((n) => !ids.has(n.id))),
      request: () => batch<{ blobs?: string[]; queuedParts?: number }>({ op: "delete", ids: [...ids] }),
    });
    const done = `${label(nodes)} deleted forever`;
    if (res.blobs?.length && res.queuedParts) {
      toast.loading(`${done} — removing from Telegram…`, { id: toastId });
      confirmRemoval(toastId, res.blobs, done);
    } else {
      // Content still referenced elsewhere (copies, identical files) stays stored.
      toast.success(done, { id: toastId });
    }
  } catch (e) {
    toast.dismiss(toastId);
    fail(e);
  }
}

export async function emptyTrash() {
  const toastId = toast.loading("Emptying the trash…");
  try {
    const res = await mutate({
      optimistic: () => patchListings((items, key) => (isView(key, "trash") ? [] : items)),
      request: () => batch<{ blobs?: string[]; queuedParts?: number }>({ op: "emptyTrash" }),
    });
    if (res.blobs?.length && res.queuedParts) {
      toast.loading("Trash emptied — removing from Telegram…", { id: toastId });
      confirmRemoval(toastId, res.blobs, "Trash emptied");
    } else {
      toast.success("Trash emptied", { id: toastId });
    }
  } catch (e) {
    toast.dismiss(toastId);
    fail(e);
  }
}

export async function moveNodes(nodes: DriveNode[], targetId: string, targetName?: string) {
  const movable = nodes.filter((n) => n.id !== targetId && n.parentId !== targetId);
  if (!movable.length) return;
  const ids = new Set(idsOf(movable));
  const from = movable[0].parentId;
  try {
    const res = await mutate({
      optimistic: () =>
        patchListings((items, key) => {
          if (key[0] !== "folder") return items;
          if (key[1] === targetId) return [...items, ...movable.filter((n) => !items.some((i) => i.id === n.id)).map((n) => ({ ...n, parentId: targetId }))];
          return items.filter((n) => !ids.has(n.id));
        }),
      request: () => batch<{ renamed?: number }>({ op: "move", ids: [...ids], targetId }),
    });
    toast(`${label(movable)} moved${targetName ? ` to “${targetName}”` : ""}`, {
      description: res.renamed ? `${plural(res.renamed, "item")} renamed — the name was taken there` : undefined,
      action:
        from && movable.every((n) => n.parentId === from)
          ? { label: "Undo", onClick: () => void moveNodes(movable.map((n) => ({ ...n, parentId: targetId })), from) }
          : undefined,
    });
  } catch (e) {
    fail(e);
  }
}

export async function copyNodes(nodes: DriveNode[], targetId: string) {
  try {
    await mutate({ request: () => batch({ op: "copy", ids: idsOf(nodes), targetId }) });
    toast(`${label(nodes)} copied — instantly, no bytes moved`);
  } catch (e) {
    fail(e);
  }
}

export async function downloadNodes(nodes: DriveNode[]) {
  if (!nodes.length) return;
  if (nodes.length === 1 && nodes[0].kind === "file") {
    // Big files: parallel, resumable and checksum-verified, straight to disk.
    if (await fastDownload(nodes[0])) return;
    downloadUrl(fileUrl(nodes[0], true));
    return;
  }
  try {
    const name = nodes.length === 1 ? nodes[0].name : `telestorage-${new Date().toISOString().slice(0, 10)}`;
    const { url } = await api<{ url: string }>("/api/zip", { method: "POST", json: { ids: idsOf(nodes), name } });
    downloadUrl(url);
    toast("Packing a ZIP on the fly…", { description: "The download starts right away — no waiting for compression." });
  } catch (e) {
    fail(e);
  }
}

// ---------------------------------------------------------------------------
// Share links
// ---------------------------------------------------------------------------

const refreshShares = () => {
  void qc?.invalidateQueries({ queryKey: ["shares"] });
  invalidate([qk.home, ["view"], ["folder"]]);
};

export async function createShare(nodeIds: string[], options: ShareOptions = {}): Promise<Share> {
  const { share } = await apiRetry<{ share: Share }>("/api/shares", {
    method: "POST",
    json: { nodeIds, ...options },
    idempotencyKey: randomKey("sh"),
    attempts: 4,
  });
  refreshShares();
  return share;
}

export async function updateShare(id: string, options: ShareOptions): Promise<Share> {
  const { share } = await patch<{ share: Share }>(`/api/shares/${id}`, options);
  refreshShares();
  return share;
}

export async function deleteShare(id: string) {
  await del(`/api/shares/${id}`);
  refreshShares();
}

export function shareUrl(id: string, kind: Share["kind"] = "share") {
  return `${location.origin}/${kind === "request" ? "r" : "s"}/${id}`;
}

/** A file request: a link that lets anyone upload into `folder` (and see nothing there). */
export async function createRequest(folder: DriveNode, options: ShareOptions = {}): Promise<Share> {
  const { share } = await apiRetry<{ share: Share }>("/api/shares", {
    method: "POST",
    json: { kind: "request", folderId: folder.id, ...options },
    idempotencyKey: randomKey("rq"),
    attempts: 4,
  });
  refreshShares();
  return share;
}

export async function copyShareLink(id: string) {
  return copyText(shareUrl(id));
}

/** The OS share sheet where there is one (phones), else the clipboard. */
export async function sendShareLink(share: Pick<Share, "id" | "title"> & { kind?: Share["kind"] }, fallbackTitle: string): Promise<"shared" | "copied" | "failed"> {
  const url = shareUrl(share.id, share.kind);
  if (typeof navigator.share === "function" && matchMedia("(pointer: coarse)").matches) {
    try {
      await navigator.share({ title: share.title ?? fallbackTitle, url });
      return "shared";
    } catch (e) {
      if ((e as Error).name === "AbortError") return "shared";
    }
  }
  return (await copyText(url)) ? "copied" : "failed";
}

/** One-click link for a single item with default options. */
export async function quickLink(nodes: DriveNode[]) {
  try {
    const share = await createShare(idsOf(nodes));
    const result = await sendShareLink(share, nodes.length === 1 ? nodes[0].name : `${nodes.length} items`);
    if (result === "copied") toast.success("Link copied", { description: "Anyone with the link can view and download." });
    else if (result === "failed") toast("Link created", { description: "Copying was blocked — open Share to copy it." });
  } catch (e) {
    fail(e);
  }
}

// ---------------------------------------------------------------------------
// Version history and folder colours
// ---------------------------------------------------------------------------

const refreshVersions = (nodeId: string) => void qc?.invalidateQueries({ queryKey: qk.versions(nodeId) });

/** Makes an earlier version current again (what it replaces stays in the history). */
export async function restoreVersion(node: DriveNode, versionId: string): Promise<boolean> {
  try {
    await mutate({
      request: () => apiRetry(`/api/nodes/${node.id}/versions/${versionId}/restore`, { method: "POST", json: {}, idempotencyKey: randomKey("rv"), attempts: 3 }),
    });
    refreshVersions(node.id);
    toast.success(`Restored an earlier version of “${node.name}”`, { description: "The version it replaced is kept in the history." });
    return true;
  } catch (e) {
    fail(e);
    return false;
  }
}

export async function deleteVersion(node: DriveNode, versionId: string) {
  try {
    await mutate({ request: () => del(`/api/nodes/${node.id}/versions/${versionId}`) });
    refreshVersions(node.id);
    toast("Version deleted");
  } catch (e) {
    fail(e);
  }
}

/** Gives folders a colour (null = default). Instant, saved in the background. */
export async function setColor(nodes: DriveNode[], color: FolderColor | null) {
  const ids = new Set(idsOf(nodes).filter((id) => nodes.find((n) => n.id === id)?.kind === "folder"));
  if (!ids.size) return;
  try {
    await mutate({
      optimistic: () => patchListings((items) => items.map((n) => (ids.has(n.id) ? { ...n, color } : n))),
      request: () => batch({ op: "color", ids: [...ids], color }),
    });
  } catch (e) {
    fail(e);
  }
}

export async function paste(targetId: string) {
  const { clipboard, setClipboard } = useUi.getState();
  if (!clipboard) return;
  if (clipboard.op === "cut") {
    await moveNodes(clipboard.nodes, targetId);
    setClipboard(null);
  } else {
    await copyNodes(clipboard.nodes, targetId);
  }
}

export async function signOut(everywhere = false) {
  await api(`/api/auth/logout${everywhere ? "?all=1" : ""}`, { method: "POST", json: {} }).catch(() => {});
  qc?.clear();
  try {
    const { clear } = await import("idb-keyval");
    await clear();
    // Drop cached thumbnails and the app shell from the service worker too.
    for (const key of await caches.keys()) await caches.delete(key);
  } catch {
    /* best effort */
  }
  // A hard navigation is deliberate: it discards every bit of in-memory client state.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  location.href = "/login";
}
