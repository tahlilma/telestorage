"use client";
import { noteRestoring } from "./restoring";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
  }

  /** Seconds the server asked us to wait (503/429 Retry-After), if any. */
  get retryAfter(): number | undefined {
    const v = (this.body as { retryAfter?: number } | undefined)?.retryAfter;
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  }
}

function onUnauthorized() {
  if (typeof window !== "undefined" && !location.pathname.startsWith("/login")) {
    const next = location.pathname + location.search;
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- full reload drops stale client state
    location.href = `/login${next !== "/" ? `?next=${encodeURIComponent(next)}` : ""}`;
  }
}

export interface ApiInit extends RequestInit {
  json?: unknown;
  /** Makes the POST safe to retry: the server replays the first outcome for this key. */
  idempotencyKey?: string;
}

export async function api<T>(path: string, init?: ApiInit): Promise<T> {
  const { json, idempotencyKey, ...rest } = init ?? {};
  let res: Response;
  try {
    res = await fetch(path, {
      ...rest,
      headers: {
        ...(json !== undefined ? { "content-type": "application/json" } : {}),
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        ...rest.headers,
      },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
      credentials: "same-origin",
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, "Network error — check your connection");
  }
  const text = await res.text();
  const body = text ? safeJson(text) : null;
  // Public share links answer 401 for "password required" — that is not a lost session.
  if (res.status === 401 && !path.startsWith("/api/auth") && !path.startsWith("/api/public")) onUnauthorized();
  if (!res.ok) {
    const msg = (body as { error?: string } | null)?.error ?? `Request failed (${res.status})`;
    if (res.status === 503 && (body as { restoring?: boolean } | null)?.restoring) noteRestoring(msg);
    const retryAfter = Number(res.headers.get("retry-after"));
    throw new ApiError(res.status, msg, { ...(body as object), ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfter } : {}) });
  }
  return body as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 200) };
  }
}

export const isRetryable = (e: unknown) =>
  e instanceof ApiError && (e.status === 0 || e.status === 408 || e.status === 425 || e.status === 429 || e.status === 502 || e.status === 503 || e.status === 504);

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });

export const waitOnline = () =>
  typeof navigator === "undefined" || navigator.onLine ? Promise.resolve() : new Promise<void>((r) => window.addEventListener("online", () => r(), { once: true }));

/**
 * `api()` with automatic retries for transient failures: network drops,
 * 502/503/504, 429. Honours Retry-After, waits for the browser to come back
 * online, and uses exponential backoff with full jitter. Pair POSTs with an
 * idempotency key so a retry can never apply twice.
 */
export async function apiRetry<T>(path: string, init?: ApiInit & { attempts?: number; signal?: AbortSignal }): Promise<T> {
  const attempts = init?.attempts ?? 8;
  for (let attempt = 1; ; attempt++) {
    try {
      return await api<T>(path, init);
    } catch (e) {
      if (!isRetryable(e) || attempt >= attempts) throw e;
      await waitOnline();
      const hinted = (e as ApiError).retryAfter;
      const backoff = hinted ? hinted * 1000 : Math.random() * Math.min(15_000, 400 * 2 ** attempt);
      await sleep(backoff, init?.signal ?? undefined);
    }
  }
}

export const get = <T>(path: string, signal?: AbortSignal) => api<T>(path, { signal });
export const post = <T>(path: string, json?: unknown, opts?: { idempotencyKey?: string }) => api<T>(path, { method: "POST", json: json ?? {}, ...opts });
export const patch = <T>(path: string, json: unknown) => api<T>(path, { method: "PATCH", json });
export const del = <T>(path: string) => api<T>(path, { method: "DELETE" });

/** Random key that works outside secure contexts (crypto.randomUUID is HTTPS-only). */
export function randomKey(prefix = "k"): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return `${prefix}-${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
}

/** Copies text even where the async Clipboard API is unavailable (plain-HTTP LAN access). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

/** Triggers a browser download without leaving the page. */
export function downloadUrl(url: string) {
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  a.download = "";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
