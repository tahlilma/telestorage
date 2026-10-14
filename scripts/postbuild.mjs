// The standalone server only serves public/ and .next/static when they sit next to it.
import fs from "node:fs";
import path from "node:path";

const dist = process.env.NEXT_DIST_DIR || ".next";
const standalone = path.join(dist, "standalone");
fs.cpSync("public", path.join(standalone, "public"), { recursive: true });
fs.cpSync(path.join(dist, "static"), path.join(standalone, dist, "static"), { recursive: true });
// File tracing follows the ./data fallback path and copies the live index database and
// secrets into the bundle. Runtime state never belongs in a build: start.mjs always
// points DATA_DIR at the real directory, so a copy here is stale at best.
fs.rmSync(path.join(standalone, "data"), { recursive: true, force: true });
console.log(`[postbuild] copied public/ and ${dist}/static into ${standalone}`);
