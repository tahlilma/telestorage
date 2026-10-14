import "server-only";
import crypto from "node:crypto";
import { config } from "../config";
import { db, kv } from "../db";
import { runFsck } from "../fsck";
import { log } from "../metrics";
import type { Runtime } from "./blobs";
import { BlockCache } from "./cache";
import { LocalDriver } from "./local";
import { kickGc, startMaintenance } from "./maintenance";
import { ensureRecovery, recoveryDone, recoveryState } from "./recovery";
import { createSimDriver } from "./sim";
import { createTelegramDriver } from "./telegram";
import { RestoringError, type StorageDriver } from "./types";

export type { Runtime } from "./blobs";

const g = globalThis as unknown as {
  __tsRuntime?: Promise<Runtime>;
  __tsRuntimeResolved?: Runtime;
  __tsStopMaintenance?: () => void;
  __tsStartAfterRecovery?: boolean;
};

function checkEncryptionKey() {
  const key = config().encryptionKey;
  if (!key) return;
  const fingerprint = crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
  const stored = kv.get("enc.fingerprint");
  if (!stored) kv.set("enc.fingerprint", fingerprint);
  else if (stored !== fingerprint) {
    log.error("crypto", "ENCRYPTION_KEY differs from the key used for existing files — those files will be unreadable!");
  }
}

function createDriver(): StorageDriver {
  const cfg = config();
  if (cfg.driver === "telegram") return createTelegramDriver();
  if (cfg.driver === "sim") return createSimDriver();
  return new LocalDriver();
}

/**
 * Process-wide storage runtime (driver + block cache + background jobs).
 * Stored on globalThis so every route bundle and dev-mode HMR reload share
 * one set of Telegram connections and one database handle.
 */
export function storage(): Promise<Runtime> {
  // A server that starts on an empty disk first brings the index back from
  // Telegram. A quick answer (usually: nothing to restore) is waited for; a
  // long restore turns into "come back in a moment" (503) instead.
  const recovering = ensureRecovery();
  if (!recoveryDone()) {
    if (!g.__tsStartAfterRecovery) {
      g.__tsStartAfterRecovery = true;
      void recovering.then(() => storage().catch(() => {}));
    }
    return Promise.race([
      recovering.then(() => storage()),
      new Promise<never>((_, reject) =>
        setTimeout(() => {
          const s = recoveryState();
          reject(new RestoringError(s?.error ? `${s.message} (${s.error})` : (s?.message ?? "Restoring your drive from Telegram…")));
        }, 3000).unref(),
      ),
    ]);
  }
  g.__tsRuntime ??= (async () => {
    const cfg = config();
    db();
    checkEncryptionKey();
    // Preemptive consistency check before serving anything.
    const report = runFsck({ repair: true });
    if (!report.ok) log.error("fsck", "index has unrepairable problems — see System status");
    const driver = createDriver();
    const t0 = Date.now();
    await driver.init();
    const rt: Runtime = { driver, cache: new BlockCache() };
    g.__tsStopMaintenance = startMaintenance(rt);
    if (report.needsGc) void kickGc(rt);
    g.__tsRuntimeResolved = rt;
    log.info("storage", `${driver.name} driver ready in ${Date.now() - t0} ms`);
    if (driver.name === "local") {
      log.warn("storage", "Telegram is not configured — files are stored on local disk (development mode)");
    } else if (driver.name === "sim") {
      log.warn("storage", `Simulated Telegram (${cfg.sim.bots} bots) — for testing only`);
    }
    return rt;
  })().catch((e) => {
    log.error("storage", `startup failed: ${(e as Error).message}`);
    // Keep failing fast for a while instead of re-dialing Telegram on every request.
    setTimeout(() => (g.__tsRuntime = undefined), 20_000).unref();
    throw e;
  });
  return g.__tsRuntime;
}

/** The runtime if it has finished starting, without triggering startup. */
export function storageIfReady(): Runtime | undefined {
  return g.__tsRuntimeResolved;
}

/** Stops background jobs and disconnects storage (tests, graceful shutdown). */
export async function shutdownStorage() {
  g.__tsStopMaintenance?.();
  const rt = g.__tsRuntimeResolved;
  g.__tsRuntime = undefined;
  g.__tsRuntimeResolved = undefined;
  await rt?.driver.stop();
}
