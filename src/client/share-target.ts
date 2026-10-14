"use client";
import { toast } from "sonner";
import { openPicker } from "./pickers";
import { useUi } from "./store";

const SHARED = "telestorage-shared-v1";

/**
 * Arrivals through the URL: files shared from another app (the service worker
 * parked them and opened /?received=<id>), and the "Upload files" app shortcut
 * (/files?upload=1). Runs once when the app opens.
 */
export async function handleArrivals() {
  const params = new URLSearchParams(location.search);
  const received = params.get("received");
  const upload = params.get("upload");
  if (!received && !upload) return;
  params.delete("received");
  params.delete("upload");
  history.replaceState(history.state, "", location.pathname + (params.size ? `?${params}` : ""));

  if (upload) {
    // A file dialog needs a tap first (browsers allow pickers only from a gesture).
    toast("Upload files", { description: "Pick the files to upload to My files.", action: { label: "Choose files", onClick: () => openPicker("files", "root") }, duration: 15_000 });
  }
  if (received === "unsupported") {
    toast("Couldn't receive the shared files", { description: "Open Telestorage once so it can finish installing, then share again." });
    return;
  }
  if (received && /^[a-z0-9]+$/.test(received)) {
    try {
      const files = await takeShared(received);
      if (files.length) useUi.getState().openDialog({ type: "receive", files });
      else toast("Nothing came through", { description: "The app you shared from didn't send any files." });
    } catch {
      toast.error("Couldn't read the shared files");
    }
  }
}

/** Takes a parked batch out of Cache Storage as File objects (and clears it). */
async function takeShared(id: string): Promise<File[]> {
  if (typeof caches === "undefined") return [];
  const cache = await caches.open(SHARED);
  const keys = (await cache.keys())
    .filter((r) => new URL(r.url).pathname.startsWith(`/__shared/${id}/`))
    .sort((a, b) => Number(a.url.split("/").pop()) - Number(b.url.split("/").pop()));
  const files: File[] = [];
  for (const key of keys) {
    const res = await cache.match(key);
    if (!res) continue;
    const blob = await res.blob();
    files.push(
      new File([blob], decodeURIComponent(res.headers.get("x-name") ?? "Shared file"), {
        type: blob.type,
        lastModified: Number(res.headers.get("x-modified")) || Date.now(),
      }),
    );
    await cache.delete(key);
  }
  return files;
}
