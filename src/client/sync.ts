"use client";
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { create } from "zustand";
import type { ChangeEvent, FolderListing } from "@/lib/types";
import { navigate, parseRoute } from "./router";

/**
 * Consistency layer between optimistic UI, the server and other devices.
 *
 * Mutations: before applying an optimistic change we cancel in-flight listing
 * fetches (a response that left the server *before* the mutation must never
 * overwrite it), and refetches are deferred until every concurrent mutation
 * has settled — so a deleted item disappears once and stays gone.
 *
 * Live feed: one tab per browser is elected leader (Web Locks), holds the
 * /api/events stream and relays changes to the other tabs over
 * BroadcastChannel. Every change invalidates exactly the affected listings.
 */

const LISTING = new Set(["folder", "folders", "view", "search", "node", "home", "shares", "activity"]);

let qc: QueryClient | null = null;
let pending = 0;
const deferredKeys = new Map<string, readonly unknown[]>();
let deferredAll = false;

export const useLive = create<{ live: boolean; since: number | null; stale: boolean }>()(() => ({ live: false, since: null, stale: false }));

const BUILD = process.env.NEXT_PUBLIC_BUILD_ID ?? null;

export function bindSync(client: QueryClient) {
  if (qc) return;
  qc = client;
  if (typeof window !== "undefined") startLiveFeed();
}

function invalidateNow(keys: readonly (readonly unknown[])[] | "all") {
  if (!qc) return;
  if (keys === "all") {
    void qc.invalidateQueries({ predicate: (q) => LISTING.has(String(q.queryKey[0])) });
    void qc.invalidateQueries({ queryKey: ["system"] });
    return;
  }
  for (const k of keys) void qc.invalidateQueries({ queryKey: k });
}

/** Invalidate now, or right after the in-flight mutations settle. */
export function invalidate(keys: readonly (readonly unknown[])[] | "all") {
  if (pending > 0) {
    if (keys === "all") deferredAll = true;
    else for (const k of keys) deferredKeys.set(JSON.stringify(k), k);
    return;
  }
  invalidateNow(keys);
}

function flushDeferred() {
  if (deferredAll) invalidateNow("all");
  else invalidateNow([...deferredKeys.values()]);
  deferredAll = false;
  deferredKeys.clear();
}

/**
 * Runs a mutation with race-free optimistic UI. `optimistic` applies the
 * change and returns a rollback; `request` talks to the server.
 */
export async function mutate<T>(opts: { optimistic?: () => (() => void) | void; request: () => Promise<T>; invalidate?: readonly (readonly unknown[])[] | "all" }): Promise<T> {
  pending++;
  let rollback: (() => void) | void = undefined;
  try {
    await qc?.cancelQueries({ predicate: (q) => LISTING.has(String(q.queryKey[0])) });
    rollback = opts.optimistic?.();
    const out = await opts.request();
    invalidate(opts.invalidate ?? "all");
    return out;
  } catch (e) {
    rollback?.();
    throw e;
  } finally {
    pending--;
    if (pending === 0) flushDeferred();
  }
}

// A change shows instantly but is saved a moment later: leaving the page in
// between (reload, closing the tab) would drop it, so the browser asks first.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", (e) => {
    if (pending > 0) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
}

// ---------------------------------------------------------------------------
// Deletion confirmations: "removed from Telegram" once the GC event arrives
// ---------------------------------------------------------------------------

const awaitingGc = new Map<string | number, { blobs: Set<string>; label: string }>();
/** GC can finish (and its event arrive) before the delete request's own response does. */
const recentlyRemoved = new Map<string, number>();

export function confirmRemoval(toastId: string | number, blobs: string[], label: string) {
  if (!blobs.length) return;
  const now = Date.now();
  for (const [b, t] of recentlyRemoved) if (now - t > 60_000) recentlyRemoved.delete(b);
  const outstanding = new Set(blobs.filter((b) => !recentlyRemoved.has(b)));
  if (outstanding.size === 0) {
    toast.success(label, { id: toastId, description: "Removed from Telegram too." });
    return;
  }
  awaitingGc.set(toastId, { blobs: outstanding, label });
  setTimeout(() => {
    if (awaitingGc.delete(toastId)) toast.message(label, { id: toastId, description: "Queued — it will leave Telegram shortly." });
  }, 20_000);
}

function onGc(e: ChangeEvent) {
  for (const b of e.blobs ?? []) recentlyRemoved.set(b, Date.now());
  for (const [toastId, entry] of awaitingGc) {
    for (const b of e.blobs ?? []) entry.blobs.delete(b);
    if (entry.blobs.size === 0) {
      awaitingGc.delete(toastId);
      toast.success(entry.label, { id: toastId, description: "Removed from Telegram too." });
    }
  }
}

// ---------------------------------------------------------------------------
// Live feed
// ---------------------------------------------------------------------------

let lastBoot: string | null = null;

function keysFor(e: ChangeEvent): (readonly unknown[])[] {
  const keys: (readonly unknown[])[] = [["view"], ["search"], ["home"]];
  if (e.reason === "share" || e.reason === "request" || e.reason === "delete" || e.reason === "purge" || e.reason === "trash") keys.push(["shares"]);
  // A new upload over a file (or a restored version) changes its history.
  if (e.reason === "version" || e.reason === "upload") for (const id of e.ids ?? []) keys.push(["versions", id]);
  if (e.reason === "upload" || e.reason === "delete" || e.reason === "purge" || e.reason === "thumb") keys.push(["photos"], ["storage"]);
  for (const p of e.parents ?? []) keys.push(["folder", p], ["folders", p]);
  for (const id of [...(e.ids ?? []), ...(e.removed ?? [])]) keys.push(["node", id], ["folder", id]);
  keys.push(["system"]);
  return keys;
}

/** If the folder on screen (or one of its ancestors) just vanished, move somewhere that exists. */
function evacuate(removed: string[]) {
  if (!removed.length || typeof location === "undefined") return;
  const route = parseRoute(location.pathname, location.search);
  if (route.name !== "folder" || route.id === "root") return;
  const listing = qc?.getQueryData<FolderListing>(["folder", route.id]);
  const chain = listing?.path.map((c) => c.id) ?? [route.id];
  const gone = new Set(removed);
  const hit = chain.findIndex((id) => gone.has(id));
  if (hit < 0) return;
  const survivor = hit > 0 ? chain[hit - 1] : "root";
  navigate({ name: "folder", id: survivor }, { replace: true });
  toast("The folder you were in was moved to the trash");
}

/**
 * Skew protection: this tab's code is older than the server's. API changes
 * between builds are not guaranteed compatible, so ask for a reload — and do
 * it automatically when nothing would be lost (tab hidden, no uploads).
 */
async function onNewBuild() {
  if (useLive.getState().stale) return;
  useLive.setState({ stale: true });
  const { useUploads } = await import("./upload/engine");
  const busy = () => useUploads.getState().items.some((i) => i.status === "queued" || i.status === "uploading" || i.status === "holding" || i.status === "verifying");
  toast("Telestorage was updated", {
    id: "new-build",
    description: "Reload to get the new version.",
    duration: Infinity,
    action: { label: "Reload", onClick: () => location.reload() },
  });
  const maybeReload = () => {
    if (document.visibilityState === "hidden" && !busy()) location.reload();
  };
  document.addEventListener("visibilitychange", maybeReload);
  maybeReload();
}

function handle(e: ChangeEvent | { kind: "hello"; boot: string; build?: string | null }) {
  if ("kind" in e) {
    // (Re)connected: events may have been missed, so refresh everything once.
    if (lastBoot !== null) invalidate("all");
    lastBoot = e.boot;
    if (e.build && BUILD && e.build !== BUILD) void onNewBuild();
    return;
  }
  if (e.type === "nodes") {
    invalidate(keysFor(e));
    if (e.removed?.length) evacuate(e.removed);
  } else if (e.type === "gc") {
    onGc(e);
    invalidate([["system"]]);
  } else if (e.type === "activity") {
    invalidate([["activity"], ["home"], ["shares"]]);
  } else if (e.type === "backup") {
    invalidate([["system"]]);
  }
}

function setLive(live: boolean) {
  const cur = useLive.getState();
  if (cur.live !== live) useLive.setState({ live, since: live ? Date.now() : null });
}

function startLiveFeed() {
  const bc = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("telestorage-live") : null;
  let leader = false;
  const connect = (relay: boolean) => {
    const es = new EventSource("/api/events");
    es.addEventListener("hello", (msg) => {
      const h = JSON.parse((msg as MessageEvent).data) as { boot: string; build?: string | null };
      handle({ kind: "hello", boot: h.boot, build: h.build });
      setLive(true);
      if (relay) bc?.postMessage({ kind: "hello", boot: h.boot, build: h.build, live: true });
    });
    es.addEventListener("change", (msg) => {
      const ev = JSON.parse((msg as MessageEvent).data) as ChangeEvent;
      handle(ev);
      if (relay) bc?.postMessage(ev);
    });
    es.onerror = () => {
      setLive(false);
      if (relay) bc?.postMessage({ kind: "status", live: false });
    };
  };

  if (bc) {
    bc.onmessage = (m) => {
      const d = m.data as ChangeEvent | { kind: "hello" | "status" | "ping"; boot?: string; build?: string | null; live?: boolean };
      if ("kind" in d) {
        if (d.kind === "hello" && d.boot) handle({ kind: "hello", boot: d.boot, build: d.build });
        if (d.kind === "hello" || d.kind === "status") setLive(Boolean(d.live));
        if (d.kind === "ping" && leader) bc.postMessage({ kind: "status", live: useLive.getState().live });
        return;
      }
      handle(d);
    };
  }

  // Web Locks (secure contexts only): exactly one tab holds the stream; the lock
  // passes to another tab automatically when the leader closes.
  if (navigator.locks && bc) {
    void navigator.locks.request("telestorage-live-leader", () => {
      leader = true;
      connect(true);
      return new Promise(() => {}); // hold the lock for the lifetime of this tab
    });
    bc.postMessage({ kind: "ping" });
  } else {
    connect(false);
  }
}
