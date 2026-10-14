"use client";
import { ApiError } from "../api";

/**
 * PUTs one chunk with an RFC 9530 Content-Digest. XHR (not fetch) for
 * upload-progress events. Errors carry the HTTP status (0 = network) and
 * the server's Retry-After so the scheduler can back off precisely.
 */
export function putChunk(url: string, body: ArrayBuffer, digest: string, onProgress: (loaded: number) => void, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.setRequestHeader("content-digest", digest);
    // Generous but finite: a stalled connection must eventually be retried.
    xhr.timeout = Math.max(90_000, (body.byteLength / (48 * 1024)) * 1000);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let parsed: { error?: string; missing?: unknown } | null = null;
      try {
        parsed = JSON.parse(xhr.responseText);
      } catch {
        /* proxy error page */
      }
      const retryAfter = Number(xhr.getResponseHeader("retry-after"));
      reject(new ApiError(xhr.status, parsed?.error ?? `HTTP ${xhr.status}`, { ...parsed, retryAfter: Number.isFinite(retryAfter) ? retryAfter : undefined }));
    };
    xhr.onerror = () => reject(new ApiError(0, "Network error"));
    xhr.ontimeout = () => reject(new ApiError(0, "Timed out"));
    xhr.onabort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}
