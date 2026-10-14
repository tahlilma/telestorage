import "server-only";
import crypto from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** URL-safe base62 id with rejection sampling (no modulo bias). 12 chars ≈ 71 bits. */
export function newId(length = 12): string {
  let out = "";
  while (out.length < length) {
    const bytes = crypto.randomBytes(length * 2);
    for (const b of bytes) {
      const v = b & 63;
      if (v < 62) out += ALPHABET[v];
      if (out.length === length) break;
    }
  }
  return out;
}

export function isId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9A-Za-z]{1,40}$/.test(value);
}
