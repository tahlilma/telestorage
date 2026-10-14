"use client";
import { createStore, del, entries, set, type UseStore } from "idb-keyval";
import type { ConflictPolicy } from "@/lib/types";

/**
 * Unfinished uploads, remembered across reloads and browser restarts.
 *
 * A browser can't reopen a file on its own after a reload, so what survives is
 * the server session (its finished parts stay in Telegram for
 * UPLOAD_RESUME_DAYS). When you pick or drop the same file again, the upload
 * continues where it stopped instead of starting over: for a 500 GB file that
 * is the difference between minutes and days.
 */
export interface SavedUpload {
  session: string;
  name: string;
  size: number;
  lastModified: number;
  type: string;
  parentId: string;
  destination: string;
  policy: ConflictPolicy;
  partSize: number;
  savedAt: number;
}

let store: UseStore | null | undefined;
function db(): UseStore | null {
  if (store === undefined) {
    try {
      store = typeof indexedDB === "undefined" ? null : createStore("telestorage-uploads", "sessions");
    } catch {
      store = null;
    }
  }
  return store;
}

export async function rememberUpload(s: SavedUpload): Promise<void> {
  const d = db();
  if (d) await set(s.session, s, d).catch(() => {});
}

export async function forgetUpload(session: string): Promise<void> {
  const d = db();
  if (d) await del(session, d).catch(() => {});
}

export async function savedUploads(): Promise<SavedUpload[]> {
  const d = db();
  if (!d) return [];
  try {
    return (await entries<string, SavedUpload>(d)).map(([, v]) => v).sort((a, b) => a.savedAt - b.savedAt);
  } catch {
    return [];
  }
}

/** Is this the file a saved upload was reading? (Same name, size and modification time.) */
export const sameFile = (s: SavedUpload, f: File) => s.name === f.name && s.size === f.size && s.lastModified === f.lastModified;
