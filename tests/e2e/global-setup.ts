import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { TestProject } from "vitest/node";

/**
 * Boots throwaway servers for the e2e suites from the production build:
 *  - "main":  simulated 3-bot fleet, encryption on, 2 MiB parts
 *  - "tight": tiny upload buffer + slow storage, for the load-shedding test
 *  - "huge":  only with HUGE_FILE_GB set: local disk, production 512 MiB
 *             parts, for the multi-gigabyte file test
 * Each gets a fresh temp DATA_DIR and blanked credentials, so a developer's
 * real .env (Telegram bots, password) can never leak into a test run.
 * Set E2E_BASE_URL to test an already-running server instead.
 */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });

async function boot(name: string, extra: Record<string, string>) {
  const port = await freePort();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), `telestorage-e2e-${name}-`));
  const env = {
    ...process.env,
    NODE_ENV: "production",
    DATA_DIR: data,
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    STORAGE_DRIVER: "sim",
    // Present-but-empty wins over .env (neither loader overrides existing variables).
    TG_API_ID: "",
    TG_API_HASH: "",
    TG_BOT_TOKENS: "",
    TG_CHANNEL_ID: "",
    AUTH_PASSWORD: process.env.E2E_PASSWORD ?? "e2e-pass-123",
    AUTH_TOTP_SECRET: "",
    AUTH_SECRET: "",
    PUBLIC_URL: "",
    BACKUP_INTERVAL_HOURS: "0",
    ENCRYPTION_KEY: "e2e-test-passphrase",
    SIM_BOTS: "3",
    SIM_LATENCY_MS: "15",
    SIM_JITTER_MS: "10",
    TG_PART_SIZE_MB: "2",
    NEXT_TELEMETRY_DISABLED: "1",
    ...extra,
  } as NodeJS.ProcessEnv;
  const child = spawn(process.execPath, ["scripts/start.mjs"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d: Buffer) => (log += d));
  child.stderr.on("data", (d: Buffer) => (log += d));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    if (child.exitCode !== null) throw new Error(`${name} e2e server exited early:\n${log}`);
    try {
      const r = await fetch(`${url}/api/health`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    if (i > 120) throw new Error(`${name} e2e server did not become healthy:\n${log}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  return { url, data, child };
}

export default async function setup(project: TestProject) {
  if (process.env.E2E_BASE_URL) {
    project.provide("e2eBaseUrl", process.env.E2E_BASE_URL);
    project.provide("e2eData", process.env.E2E_DATA ?? "");
    project.provide("e2eTightUrl", process.env.E2E_TIGHT_URL ?? "");
    project.provide("e2eHugeUrl", process.env.E2E_HUGE_URL ?? "");
    return;
  }
  const dist = process.env.NEXT_DIST_DIR || ".next";
  if (!fs.existsSync(path.join(dist, "standalone", "server.js"))) {
    throw new Error(`No production build in ${dist}/standalone — run \`npm run build\` before the e2e suites.`);
  }
  const children: ChildProcess[] = [];
  const dirs: string[] = [];
  const main = await boot("main", {});
  children.push(main.child);
  dirs.push(main.data);
  const tight = await boot("tight", { UPLOAD_BUFFER_MB: "16", UPLOAD_QUEUE_TIMEOUT_MS: "1000", SIM_BANDWIDTH_MBPS: "2" });
  children.push(tight.child);
  dirs.push(tight.data);
  project.provide("e2eBaseUrl", main.url);
  project.provide("e2eData", main.data);
  project.provide("e2eTightUrl", tight.url);
  let hugeUrl = "";
  if (Number(process.env.HUGE_FILE_GB) > 0) {
    const huge = await boot("huge", { STORAGE_DRIVER: "local", TG_PART_SIZE_MB: "512", CACHE_DISK_GB: "0" });
    children.push(huge.child);
    dirs.push(huge.data);
    hugeUrl = huge.url;
  }
  project.provide("e2eHugeUrl", hugeUrl);

  return async () => {
    for (const c of children) c.kill();
    await new Promise((r) => setTimeout(r, 500));
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    e2eBaseUrl: string;
    e2eData: string;
    e2eTightUrl: string;
    e2eHugeUrl: string;
  }
}
