import "server-only";
import { unstable_rethrow } from "next/navigation";
import type { NextRequest } from "next/server";
import { authenticate, type Session } from "./auth";
import { log, metrics } from "./metrics";
import { GoneError, IntegrityError, RestoringError } from "./storage/types";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Extra machine-readable fields merged into the JSON error body. */
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string) => new HttpError(400, msg);
export const notFound = (msg = "Not found") => new HttpError(404, msg);
export const conflict = (msg: string) => new HttpError(409, msg);

interface Options {
  /** Require an owner session (default true). Public share routes pass false. */
  auth?: boolean;
}

type Handler<Ctx> = (req: NextRequest, ctx: Ctx, session: Session | null) => Promise<Response> | Response;

/**
 * Wraps a route handler with auth, sliding session renewal, error mapping and metrics.
 * Reading the request cookies here also guarantees the handler is never prerendered.
 */
export function route<Ctx = unknown>(handler: Handler<Ctx>, opts: Options = {}) {
  return async (req: NextRequest, ctx: Ctx): Promise<Response> => {
    metrics.inc("http.requests");
    let renew: string | undefined;
    let session: Session | null = null;
    try {
      let auth: Awaited<ReturnType<typeof authenticate>> = null;
      try {
        auth = await authenticate(req);
      } catch (e) {
        // While the index is restored, sessions can't be checked: public routes
        // (health, share links) carry on as anonymous; the rest answer "restoring".
        if (!(opts.auth === false && e instanceof RestoringError)) throw e;
      }
      if (opts.auth !== false && !auth) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      session = auth?.session ?? null;
      renew = auth?.renewCookie;
      const res = await handler(req, ctx, session);
      if (renew) {
        try {
          res.headers.append("Set-Cookie", renew);
        } catch {
          /* immutable headers (e.g. proxied responses) — renewal happens on the next request */
        }
      }
      return res;
    } catch (err) {
      // Let framework control flow (prerender bail-outs, redirects) pass through untouched.
      unstable_rethrow(err);
      if (err instanceof HttpError) {
        return Response.json({ ...err.extra, error: err.message }, { status: err.status });
      }
      // Backpressure / temporary unavailability: tell well-behaved clients when to come back.
      const retryAfter = (err as { retryAfterSec?: unknown })?.retryAfterSec;
      if (typeof retryAfter === "number") {
        const restoring = (err as { restoring?: unknown }).restoring === true;
        return Response.json(
          { error: (err as Error).message, retryAfter, ...(restoring ? { restoring: true } : {}) },
          { status: 503, headers: { "Retry-After": String(Math.max(1, Math.ceil(retryAfter))) } },
        );
      }
      if (err instanceof GoneError) return Response.json({ error: err.message }, { status: 410 });
      if (err instanceof IntegrityError) {
        log.error("integrity", `${req.method} ${req.nextUrl.pathname}: ${err.message}`);
        return Response.json({ error: err.message }, { status: 502 });
      }
      const e = err as Error;
      log.error("http", `${req.method} ${req.nextUrl.pathname} → ${e?.stack ?? String(err)}`);
      return Response.json({ error: e?.message || "Internal server error" }, { status: 500 });
    }
  };
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw badRequest("Invalid JSON body");
  }
}

/** RFC 6266 / 5987 Content-Disposition with a UTF-8 filename and an ASCII fallback. */
export function contentDisposition(type: "inline" | "attachment", filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
