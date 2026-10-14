import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Every test file gets its own throwaway data directory and never touches Telegram.
const PREFIX = "hangar-test-";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
process.env.DATA_DIR = dir;
process.env.STORAGE_DRIVER ??= "local";
process.env.AUTH_PASSWORD ??= "test-password";
process.env.BACKUP_INTERVAL_HOURS = "0";
process.env.SCRUB_MBPS ??= "0";
for (const k of ["TG_API_ID", "TG_API_HASH", "TG_BOT_TOKENS", "TG_CHANNEL_ID", "ENCRYPTION_KEY"]) {
  if (!process.env[`KEEP_${k}`]) delete process.env[k];
}

// Clean up after ourselves. On Windows the index database may still be open at
// exit and block removal, so every run also sweeps directories that earlier
// runs (or crashed ones) left behind.
process.on("exit", () => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* swept by a later run */
  }
});
const STALE_MS = 15 * 60 * 1000;
for (const name of fs.readdirSync(os.tmpdir())) {
  if (!name.startsWith(PREFIX)) continue;
  const full = path.join(os.tmpdir(), name);
  try {
    if (full !== dir && Date.now() - fs.statSync(full).mtimeMs > STALE_MS) fs.rmSync(full, { recursive: true, force: true });
  } catch {
    /* in use by a parallel run */
  }
}
