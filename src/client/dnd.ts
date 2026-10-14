"use client";
import type { UploadEntry } from "./upload/engine";

export const NODE_MIME = "application/x-telestorage-nodes";

export function hasFiles(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types).includes("Files");
}

export function hasNodes(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types).includes(NODE_MIME);
}

export function readNodeIds(dt: DataTransfer): string[] {
  try {
    return JSON.parse(dt.getData(NODE_MIME)) as string[];
  } catch {
    return [];
  }
}

/**
 * Expands a drop into files with relative paths, recursing into dropped
 * folders. Entries must be captured synchronously inside the drop handler —
 * the DataTransfer is neutered once the event returns — so call this first.
 */
export function collectDrop(dt: DataTransfer): Promise<{ entries: UploadEntry[]; dirs: string[] }> {
  const roots = Array.from(dt.items)
    .filter((i) => i.kind === "file")
    .map((i) => i.webkitGetAsEntry?.())
    .filter((e): e is FileSystemEntry => !!e);
  const fallback = Array.from(dt.files);

  return (async () => {
    if (!roots.length) return { entries: fallback.map((file) => ({ file })), dirs: [] };
    const entries: UploadEntry[] = [];
    const dirs: string[] = [];

    const readAll = async (dir: FileSystemDirectoryEntry) => {
      const reader = dir.createReader();
      const all: FileSystemEntry[] = [];
      // readEntries returns at most ~100 entries per call.
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) return all;
        all.push(...batch);
      }
    };

    const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
      if (entry.isFile) {
        const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
        entries.push({ file, path: prefix + file.name });
      } else if (entry.isDirectory) {
        const path = prefix + entry.name;
        dirs.push(path);
        const children = await readAll(entry as FileSystemDirectoryEntry);
        await Promise.all(children.map((c) => walk(c, `${path}/`)));
      }
    };

    await Promise.all(roots.map((r) => walk(r, "")));
    return { entries, dirs };
  })();
}

/** Files from <input webkitdirectory>, which carry their relative path. */
export function entriesFromInput(files: FileList): UploadEntry[] {
  return Array.from(files).map((file) => ({ file, path: file.webkitRelativePath || file.name }));
}

/** Small "N items" badge used as the drag image for internal moves. */
export function setDragBadge(dt: DataTransfer, label: string) {
  const el = document.createElement("div");
  el.textContent = label;
  el.style.cssText =
    "position:fixed;top:-100px;left:-100px;padding:8px 14px;border-radius:12px;font:600 13px var(--font-ui), sans-serif;background:var(--accent);color:var(--on-accent);box-shadow:var(--shadow-2)";
  document.body.appendChild(el);
  dt.setDragImage(el, 16, 16);
  setTimeout(() => el.remove(), 0);
}
