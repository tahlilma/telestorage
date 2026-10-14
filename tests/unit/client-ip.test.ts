import { describe, expect, it } from "vitest";
import { clientIp } from "@/server/auth";

const ip = (headers: Record<string, string>) => clientIp({ headers: new Headers(headers) });

describe("clientIp (the key for password rate limits)", () => {
  it("uses the address the nearest proxy recorded: the last X-Forwarded-For entry", () => {
    expect(ip({ "x-forwarded-for": "203.0.113.7" })).toBe("203.0.113.7");
    // Cloudflare appends the real address after whatever the visitor sent.
    expect(ip({ "x-forwarded-for": "1.2.3.4, 203.0.113.7" })).toBe("203.0.113.7");
  });

  it("ignores headers a visitor can set themselves behind Tailscale Funnel", () => {
    // Funnel overwrites X-Forwarded-For but passes these through untouched.
    expect(ip({ "x-forwarded-for": "203.0.113.7", "cf-connecting-ip": "10.9.8.7", "x-real-ip": "10.6.5.4" })).toBe("203.0.113.7");
  });

  it("puts requests without a proxy header in one shared bucket", () => {
    expect(ip({})).toBe("local");
    expect(ip({ "x-forwarded-for": " " })).toBe("local");
  });
});
