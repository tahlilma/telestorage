import "server-only";
import { sql } from "./db";
import { badRequest } from "./http";
import { metrics } from "./metrics";

interface Snapshot {
  status: number;
  body: string;
  contentType: string;
}

const g = globalThis as unknown as { __tsIdem?: Map<string, Promise<Snapshot>> };
const inflight = (g.__tsIdem ??= new Map());

const toResponse = (s: Snapshot, replayed: boolean) =>
  new Response(s.body, {
    status: s.status,
    headers: { "content-type": s.contentType, ...(replayed ? { "idempotent-replayed": "true" } : {}) },
  });

/**
 * Exactly-once semantics for non-idempotent POSTs. A client that retries after
 * a dropped connection sends the same `Idempotency-Key`; it gets the original
 * response instead of a second folder/upload/copy. Concurrent duplicates wait
 * for the first execution. Records expire after a day.
 */
export async function idempotent(req: Request, scope: string, handler: () => Promise<Response>): Promise<Response> {
  const raw = req.headers.get("idempotency-key");
  if (!raw) return handler();
  if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(raw)) throw badRequest("Invalid Idempotency-Key");
  const key = `${scope}:${raw}`;

  const stored = sql("SELECT status, body FROM idempotency WHERE key = ?").get(key) as { status: number; body: string } | undefined;
  if (stored) {
    metrics.inc("idempotency.replays");
    return toResponse({ ...stored, contentType: "application/json" }, true);
  }
  const running = inflight.get(key);
  if (running) {
    metrics.inc("idempotency.replays");
    return toResponse(await running, true);
  }

  const p = (async (): Promise<Snapshot> => {
    const res = await handler();
    const snap: Snapshot = { status: res.status, body: await res.text(), contentType: res.headers.get("content-type") ?? "application/json" };
    // Only definitive outcomes are remembered; a 5xx should be retried for real.
    if (res.status < 500) {
      sql("INSERT OR REPLACE INTO idempotency (key, status, body, created_at) VALUES (?, ?, ?, ?)").run(key, snap.status, snap.body, Date.now());
    }
    return snap;
  })();
  inflight.set(key, p);
  try {
    return toResponse(await p, false);
  } finally {
    inflight.delete(key);
  }
}

export function sweepIdempotency(maxAgeMs = 24 * 60 * 60 * 1000) {
  sql("DELETE FROM idempotency WHERE created_at < ?").run(Date.now() - maxAgeMs);
}
