import "server-only";
import crypto from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import type { NextRequest } from "next/server";
import { config } from "./config";
import { kv } from "./db";
import { RestoringError } from "./storage/types";

export const SESSION_COOKIE = "ts_session";
const RENEW_AFTER_MS = 24 * 60 * 60 * 1000;

const encoder = new TextEncoder();
const secretKey = () => encoder.encode(config().auth.secret);

function sessionVersion(): number {
  return Number(kv.get("auth.sessionVersion") ?? "1");
}

/** Invalidates every existing session ("sign out everywhere"). */
export function revokeAllSessions() {
  kv.set("auth.sessionVersion", String(sessionVersion() + 1));
}

export async function createSessionToken(): Promise<string> {
  const days = config().auth.sessionDays;
  return new SignJWT({ v: sessionVersion(), m: "password" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("owner")
    .setIssuedAt()
    .setExpirationTime(`${days}d`)
    .sign(secretKey());
}

export interface Session {
  method: "password";
  issuedAt: number;
}

export async function verifySessionToken(token: string | undefined): Promise<Session | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ["HS256"], subject: "owner" });
    if (payload.v !== sessionVersion()) return null;
    // Password is the only way in; a session from a removed sign-in method is not honoured.
    if (payload.m !== "password") return null;
    return { method: "password", issuedAt: (payload.iat ?? 0) * 1000 };
  } catch (e) {
    // The index is still coming back from Telegram: that's "wait", not "signed out".
    if (e instanceof RestoringError) throw e;
    return null;
  }
}

/** Origin as seen by the browser, honouring reverse proxies / tunnels. */
export function externalOrigin(req: NextRequest): string {
  const configured = config().publicUrl;
  if (configured) return configured;
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0].trim() ?? req.nextUrl.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host")?.split(",")[0].trim() ?? req.headers.get("host") ?? req.nextUrl.host;
  return `${proto}://${host}`;
}

export function isSecure(req: NextRequest) {
  return externalOrigin(req).startsWith("https://");
}

export function sessionCookie(req: NextRequest, token: string): string {
  const maxAge = config().auth.sessionDays * 86400;
  return [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    isSecure(req) ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/**
 * Verifies the session cookie. When the token is older than a day a fresh
 * cookie is returned so that an active user is never logged out (sliding expiry).
 */
export async function authenticate(req: NextRequest): Promise<{ session: Session; renewCookie?: string } | null> {
  const session = await verifySessionToken(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return null;
  if (Date.now() - session.issuedAt > RENEW_AFTER_MS) {
    const token = await createSessionToken();
    return { session, renewCookie: sessionCookie(req, token) };
  }
  return { session };
}

// ---------------------------------------------------------------------------
// Password + TOTP
// ---------------------------------------------------------------------------

export function passwordEnabled() {
  return Boolean(config().auth.password);
}

export function checkPassword(input: string): boolean {
  const expected = config().auth.password;
  if (!expected) return false;
  const key = secretKey();
  const a = crypto.createHmac("sha256", key).update(input).digest();
  const b = crypto.createHmac("sha256", key).update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of input.replace(/=+$/, "")) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) throw new Error("Invalid base32 in AUTH_TOTP_SECRET");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totpAt(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac("sha1", secret).update(msg).digest();
  const offset = h[h.length - 1] & 0xf;
  const code = (h.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, "0");
}

export function totpEnabled() {
  return Boolean(config().auth.totpSecret);
}

export function checkTotp(code: string): boolean {
  const secret = config().auth.totpSecret;
  if (!secret) return true;
  const key = base32Decode(secret);
  const counter = Math.floor(Date.now() / 30000);
  const clean = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  // ±1 step tolerates clock drift between phone and server.
  return [-1, 0, 1].some((d) => {
    const expected = totpAt(key, counter + d);
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(clean));
  });
}

// ---------------------------------------------------------------------------
// Brute-force protection (in-memory sliding window per client IP)
// ---------------------------------------------------------------------------

const g = globalThis as unknown as { __tsLoginAttempts?: Map<string, number[]> };
const attempts = (g.__tsLoginAttempts ??= new Map<string, number[]>());
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 8;

/**
 * The visitor's address, for rate limits. Only the last X-Forwarded-For entry
 * counts: Cloudflare and Caddy append the address they saw, and Tailscale
 * Serve/Funnel overwrites the header with it. Earlier entries, and headers such
 * as CF-Connecting-IP or X-Real-IP, can be sent by the visitor (Tailscale passes
 * them through), which would let every password guess claim a new address.
 * Behind no proxy there's no header and all requests share one limit; reached
 * directly from the internet, any header could be forged, so expose the server
 * only through a tunnel or proxy.
 */
export function clientIp(req: { headers: Headers }): string {
  return req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || "local";
}

export function loginBlockedFor(ip: string): number {
  const now = Date.now();
  const list = (attempts.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  attempts.set(ip, list);
  if (list.length < MAX_FAILURES) return 0;
  return Math.ceil((list[0] + WINDOW_MS - now) / 1000);
}

export function recordLoginFailure(ip: string) {
  const list = attempts.get(ip) ?? [];
  list.push(Date.now());
  attempts.set(ip, list);
}

export function clearLoginFailures(ip: string) {
  attempts.delete(ip);
}
