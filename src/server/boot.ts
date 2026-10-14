import "server-only";
import { log } from "./metrics";
import { shutdownStorage, storage, storageIfReady } from "./storage";
import { releaseDrive } from "./storage/backup";

/**
 * Server start (from instrumentation.ts, Node.js runtime only).
 *
 * Opens the database and dials Telegram while the HTTP server boots, so the
 * first request doesn't pay for MTProto handshakes; on an empty disk the index
 * is restored from Telegram first. Not awaited: a Telegram outage must not
 * stop the server from starting (requests retry on demand).
 */
export async function boot() {
  storage().catch(() => {});

  // Stopping (a redeploy, a free host putting the instance to sleep, Ctrl+C):
  // back up what isn't yet and mark the backup final, so the next server
  // restores it straight away. Next.js leaves the signals to us when
  // NEXT_MANUAL_SIG_HANDLE is set (scripts/start.mjs and the Dockerfile do).
  if (!process.env.NEXT_MANUAL_SIG_HANDLE) return;
  const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<void>((r) => setTimeout(r, ms).unref())]);
  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    const rt = storageIfReady();
    if (rt) {
      log.info("server", `${signal}: backing up and handing the drive over before stopping…`);
      await within(
        releaseDrive(rt).catch(() => {}),
        25_000,
      );
    }
    await within(shutdownStorage().catch(() => {}), 5000);
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}
