"use client";
import type { DriveNode, FolderListing } from "@/lib/types";
import { queryClient } from "./query-client";

/**
 * Native file/folder pickers. The inputs stay rendered (visually hidden, not
 * display:none) and are opened with `showPicker()` where supported — the
 * standard way to open the OS dialog from any button — with `.click()` as
 * the fallback. Must be called from a user gesture (click / key press).
 */
let filesInput: HTMLInputElement | null = null;
let folderInput: HTMLInputElement | null = null;
let target = { id: "root", name: "My files" };

export function registerPickers(files: HTMLInputElement | null, folder: HTMLInputElement | null) {
  filesInput = files;
  folderInput = folder;
}

export function pickerTarget() {
  return target;
}

/** Display name of a folder, from whatever listing is already cached. */
export function folderNameOf(id: string): string {
  if (id === "root") return "My files";
  return queryClient.getQueryData<FolderListing>(["folder", id])?.path.at(-1)?.name ?? "this folder";
}

/**
 * "Upload new version": pick one file; it becomes the new content of `node`
 * (same file, same links; the old content goes into its version history),
 * whatever the picked file is called.
 */
export function pickNewVersion(node: DriveNode) {
  const input = document.createElement("input");
  input.type = "file";
  input.style.cssText = "position:fixed;left:-9999px;opacity:0";
  document.body.appendChild(input);
  input.addEventListener(
    "change",
    async () => {
      const picked = input.files?.[0];
      input.remove();
      if (!picked) return;
      const file = picked.name === node.name ? picked : new File([picked], node.name, { type: picked.type || node.mime || "", lastModified: picked.lastModified });
      const { enqueueUploads } = await import("./upload/engine");
      const parentId = node.parentId ?? "root";
      void enqueueUploads([{ file }], parentId, [], folderNameOf(parentId), { policy: "replace" });
    },
    { once: true },
  );
  input.addEventListener("cancel", () => input.remove(), { once: true });
  try {
    input.showPicker();
  } catch {
    input.click();
  }
}

export function openPicker(kind: "files" | "folder", folderId: string, folderName = folderNameOf(folderId)): boolean {
  target = { id: folderId, name: folderName };
  const input = kind === "files" ? filesInput : folderInput;
  if (!input) return false;
  input.value = "";
  try {
    if (typeof input.showPicker === "function") {
      input.showPicker();
      return true;
    }
  } catch {
    /* older engines throw for file inputs — fall back to a synthetic click */
  }
  input.click();
  return true;
}
