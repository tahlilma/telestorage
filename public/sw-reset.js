/* Telestorage service worker, development stand-in.
 * Under `next dev`, next.config rewrites /sw.js to this file. A worker left by a
 * production run on the same origin would keep answering with its cached app
 * shell and cache-first /_next/static files; dev chunk URLs are not
 * content-hashed, so new pages and styles would never show. When the browser
 * next checks /sw.js for updates it installs this instead, which deletes those
 * caches, unregisters itself and reloads open tabs from the dev server.
 */
self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key.startsWith("telestorage-")) await caches.delete(key);
      await self.registration.unregister();
      for (const client of await self.clients.matchAll({ type: "window" })) client.navigate(client.url).catch(() => {});
    })(),
  );
});
