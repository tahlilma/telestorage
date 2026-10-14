import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

/**
 * Build identity for skew protection: a content hash of the app source, so
 * every process that evaluates this config during one build agrees on it and
 * it changes whenever the code does. The live feed compares it with the
 * running tab's own and asks stale tabs to reload after an update.
 */
function sourceHash(): string {
  const h = crypto.createHash("sha256");
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else h.update(p).update(fs.readFileSync(p));
    }
  };
  for (const dir of ["src", "public"]) if (fs.existsSync(dir)) walk(dir);
  for (const file of ["package-lock.json", "next.config.ts"]) if (fs.existsSync(file)) h.update(fs.readFileSync(file));
  return h.digest("hex").slice(0, 12);
}

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // Self-contained server bundle for Docker / bare-metal deploys.
  output: "standalone",
  // Build somewhere else while a server is still running from .next (Windows locks its files).
  distDir: process.env.NEXT_DIST_DIR || ".next",
  poweredByHeader: false,
  env: { NEXT_PUBLIC_BUILD_ID: process.env.BUILD_ID || sourceHash() },
  // The data directory (index database, secrets) is runtime state: never copy it into a build.
  outputFileTracingExcludes: { "*": ["data/**/*"] },
  // Native / long-lived-connection packages must be required at runtime, never bundled.
  serverExternalPackages: ["telegram", "better-sqlite3", "big-integer"],
  experimental: {
    optimizePackageImports: ["lucide-react", "radix-ui", "motion"],
    // The dev cache (.next/dev/cache) served stale server HTML after edits made
    // while `next dev` was stopped. Dev compiles from scratch: slower first load,
    // never a stale page. (Production builds keep their cache.)
    turbopackFileSystemCacheForDev: false,
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default function config(phase: string): NextConfig {
  if (phase !== PHASE_DEVELOPMENT_SERVER) return nextConfig;
  return {
    ...nextConfig,
    // A service worker installed by a production run on this origin would keep
    // serving its cached shell and cache-first /_next/static files under
    // `next dev`, whose chunk URLs aren't content-hashed: pages and styles
    // would stay stale. The browser's next update check of /sw.js gets a
    // worker that clears those caches and unregisters itself instead.
    async rewrites() {
      return { beforeFiles: [{ source: "/sw.js", destination: "/sw-reset.js" }], afterFiles: [], fallback: [] };
    },
  };
}
