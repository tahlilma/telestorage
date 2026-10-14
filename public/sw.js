/* Telestorage service worker.
 *  - /_next/static/*  hashed & immutable  → cache-first, forever (only responses the
 *                                           server marks immutable: never dev chunks)
 *  - /api/thumbs/*    content-addressed   → cache-first, bounded
 *  - drive pages      one shared shell    → network-first, cached shell if the network
 *                                           is slower than 1.5 s or offline
 *  - POST /share-target                    files shared from another app (Android
 *                                           share sheet) → parked here, then the app
 *                                           asks where to upload them
 * File contents and API JSON are never cached here (React Query persists listings,
 * and the browser HTTP cache handles immutable file bytes).
 */
// Bump on protocol changes: activation deletes every cache not listed here.
const ASSETS = "telestorage-assets-v4";
const THUMBS = "telestorage-thumbs-v3";
const SHELL = "telestorage-shell-v4";
const SHARED = "telestorage-shared-v1";
const KEEP = [ASSETS, THUMBS, SHELL, SHARED];
const MAX_THUMBS = 3000;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (!KEEP.includes(key)) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

async function cacheFirst(cacheName, request) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  // Only a production server marks /_next/static immutable; a dev server's chunk
  // URLs are reused for new contents and must never be pinned here.
  const keep = cacheName !== ASSETS || /\bimmutable\b/.test(res.headers.get("cache-control") ?? "");
  if (keep && res.ok && res.type === "basic") {
    cache.put(request, res.clone());
    if (cacheName === THUMBS) trim(cache);
  }
  return res;
}

let trimming = false;
async function trim(cache) {
  if (trimming) return;
  trimming = true;
  try {
    const keys = await cache.keys();
    for (let i = 0; i < keys.length - MAX_THUMBS; i++) await cache.delete(keys[i]);
  } finally {
    trimming = false;
  }
}

// Public pages (share links /s/, file requests /r/) and sign-in are never the drive shell.
const isDrivePage = (url) =>
  !url.pathname.startsWith("/api/") &&
  !url.pathname.startsWith("/s/") &&
  !url.pathname.startsWith("/r/") &&
  !url.pathname.startsWith("/login") &&
  !url.pathname.startsWith("/share-target") &&
  !url.pathname.startsWith("/_next/");

/**
 * Files shared into the installed app. They are parked in Cache Storage under
 * one batch id; the app picks them up from /?received=<id>, asks where they
 * should go, uploads them and clears the batch.
 */
async function receiveShare(request) {
  const form = await request.formData();
  const files = form.getAll("files").filter((f) => typeof f === "object" && f !== null && "name" in f);
  const text = ["title", "text", "url"]
    .map((k) => form.get(k))
    .filter((v) => typeof v === "string" && v.trim())
    .join("\n");
  const cache = await caches.open(SHARED);
  for (const key of await cache.keys()) await cache.delete(key); // only the newest share is kept
  const id = Date.now().toString(36);
  const put = (i, blob, name, modified) =>
    cache.put(
      `/__shared/${id}/${i}`,
      new Response(blob, { headers: { "content-type": blob.type || "application/octet-stream", "x-name": encodeURIComponent(name), "x-modified": String(modified || Date.now()) } }),
    );
  let i = 0;
  for (const f of files) await put(i++, f, f.name || `Shared file ${i}`, f.lastModified);
  // Shared text or a link with no file: keep it as a small text file.
  if (!files.length && text) await put(i++, new Blob([`${text}\n`], { type: "text/plain" }), `Shared ${new Date().toISOString().slice(0, 10)}.txt`);
  return Response.redirect(`/?received=${id}`, 303);
}

async function shell(request) {
  const cache = await caches.open(SHELL);
  const network = fetch(request).then((res) => {
    // Only cache a real, authenticated shell — never a redirect to /login.
    if (res.ok && !res.redirected && res.type === "basic") cache.put("/", res.clone());
    return res;
  });
  const timeout = new Promise((resolve) => setTimeout(resolve, 1500));
  const first = await Promise.race([network.catch(() => null), timeout]);
  if (first) return first;
  const cached = await cache.match("/");
  return cached ?? network;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.method === "POST" && url.pathname === "/share-target") {
    event.respondWith(receiveShare(request));
    return;
  }
  if (request.method !== "GET") return;

  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(ASSETS, request));
  } else if (url.pathname.startsWith("/api/thumbs/")) {
    event.respondWith(cacheFirst(THUMBS, request));
  } else if (request.mode === "navigate" && isDrivePage(url)) {
    event.respondWith(shell(request));
  }
});
