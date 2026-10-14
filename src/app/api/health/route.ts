import { route } from "@/server/http";
import { storageIfReady } from "@/server/storage";
import { recoveryState } from "@/server/storage/recovery";

/**
 * Liveness/readiness probe for Docker, hosts and uptime monitors.
 *
 * While the index is being restored from Telegram the server answers 200
 * with `ready: false`: a host doing a zero-downtime redeploy only stops the
 * old server once the new one looks healthy, and the old one's final backup
 * (its hand-over) is exactly what the new one is waiting for.
 */
export const GET = route(
  async () => {
    const rec = recoveryState();
    if (rec && rec.phase !== "ready") {
      const failed = rec.phase === "failed";
      return Response.json(
        { ok: !failed, ready: false, restoring: true, phase: rec.phase, message: rec.message, error: rec.error },
        { status: failed ? 503 : 200, headers: { "Cache-Control": "no-store" } },
      );
    }
    const rt = storageIfReady();
    const bots = rt?.driver.status().bots ?? [];
    const ready = Boolean(rt) && (rt!.driver.name === "local" || bots.some((b) => b.state === "ready"));
    return Response.json(
      { ok: ready, ready, driver: rt?.driver.name ?? null, botsReady: bots.filter((b) => b.state === "ready").length },
      { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } },
    );
  },
  { auth: false },
);
