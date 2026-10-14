// Production launcher for the standalone build.
//
// Next's standalone server.js chdir()s into .next/standalone, so a relative
// DATA_DIR would otherwise resolve *inside the build output* — which the next
// `next build` deletes. Resolve it against the project root first.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

if (fs.existsSync(".env")) process.loadEnvFile(".env");
process.env.NODE_ENV = "production";
process.env.DATA_DIR = path.resolve(process.env.DATA_DIR || "data");
process.env.PORT ??= "3000";
// Keep idle connections open longer than any proxy in front (Cloudflare Tunnel keeps
// them 90 s, load balancers ~60 s). With Node's 5 s default the proxy reuses a socket
// the server just closed and the request fails with a reset / 502.
process.env.KEEP_ALIVE_TIMEOUT ??= "120000";
// Stopping (Ctrl+C, docker stop) first backs the index up and hands the drive
// over (src/instrumentation.ts); Next.js would otherwise exit at once.
process.env.NEXT_MANUAL_SIG_HANDLE ??= "true";

const server = path.resolve(process.env.NEXT_DIST_DIR || ".next", "standalone/server.js");
if (!fs.existsSync(server)) {
  console.error("No production build found. Run `npm run build` first.");
  process.exit(1);
}
console.log(`[telestorage] data directory: ${process.env.DATA_DIR}`);
await import(pathToFileURL(server).href);
