import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { body, fileDigests, planChunks, sha, shuffle, sliceFor } from "../support/upload-client";

/**
 * The exact production pool (P2C balancing, breakers, flood handling, commit
 * pacing, failover) driven against simulated Telegram bots that misbehave on
 * purpose: transient errors, flood waits, silently dropped pieces, bit rot.
 */
process.env.STORAGE_DRIVER = "sim";
process.env.TG_PART_SIZE_MB = "2";
process.env.SIM_BOTS = "4";
process.env.SIM_CONNECTIONS = "2";
process.env.SIM_LATENCY_MS = "3";
process.env.SIM_JITTER_MS = "5";
process.env.SIM_FAULT_RATE = "0.1";
process.env.SIM_FLOOD_RATE = "0.08";
process.env.SIM_FLOOD_SECONDS = "1";
// High enough that "no piece was dropped at all" is a ~0.2 % event, not a flaky run.
process.env.SIM_DROP_RATE = "0.06";
process.env.SIM_CORRUPT_RATE = "0.06";
process.env.SIM_SLOW_BOT = "3";
process.env.SIM_COMMITS_PER_MINUTE = "6000";
process.env.TG_HEDGING = "false"; // hedging has its own suite
const PART = 2 * 1024 * 1024;

type Runtime = import("@/server/storage").Runtime;
let rt: Runtime;
let up: typeof import("@/server/storage/uploads");
let blobs: typeof import("@/server/storage/blobs");
let metrics: typeof import("@/server/metrics").metrics;
let shutdown: () => Promise<void>;

beforeAll(async () => {
  const s = await import("@/server/storage");
  rt = await s.storage();
  shutdown = s.shutdownStorage;
  up = await import("@/server/storage/uploads");
  blobs = await import("@/server/storage/blobs");
  ({ metrics } = await import("@/server/metrics"));
});

afterAll(async () => {
  await shutdown();
});

const isRetryable = (e: unknown) => {
  const status = (e as { status?: number }).status;
  return status === undefined || status === 409 || status === 422 || (e as { retryAfterSec?: number }).retryAfterSec !== undefined;
};

/** A client that behaves like the browser engine: retries 409/422/503 and transient failures. */
async function resilientUpload(data: Buffer, name: string) {
  const init = up.createUpload(rt, { name, size: data.length, mime: null, parentId: "root" });
  if ("node" in init) return init.node;
  const sendRange = async (r: { part: number; offset: number; length: number }) => {
    const chunk = sliceFor(data, PART, r);
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        return await up.writeChunk(rt, init.id, r.part, r.offset, body(chunk), { digest: sha(chunk), contentLength: chunk.length });
      } catch (e) {
        if (!isRetryable(e)) throw e;
        await new Promise((res) => setTimeout(res, 10 + attempt * 10));
      }
    }
    throw new Error("chunk kept failing");
  };
  let queue = shuffle(planChunks(data.length, PART), data.length);
  const d = fileDigests(data, PART);
  for (let round = 0; round < 40; round++) {
    let i = 0;
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        while (i < queue.length) await sendRange(queue[i++]);
      }),
    );
    try {
      const res = await up.completeUpload(rt, init.id, d);
      if ("node" in res) return res.node;
      queue = res.missing;
    } catch (e) {
      if (!isRetryable(e)) throw e;
      queue = up.uploadStatus(init.id).missing;
      await new Promise((res) => setTimeout(res, 50));
    }
  }
  throw new Error("upload never converged");
}

async function coldRead(blobId: string) {
  await rt.cache.forgetBlob(blobId); // force every block back through the pool
  const blob = blobs.loadBlob(blobId)!;
  const reader = blobs.openRangeStream(rt, blob, 0, blob.size - 1).getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return Buffer.concat(parts);
}

describe("bot pool under chaos", () => {
  it("lands every upload intact and serves verified bytes despite injected failures", async () => {
    const files = Array.from({ length: 10 }, (_, i) => crypto.randomBytes(PART * (1 + (i % 4)) + 1000 * i + 17));
    const nodes = await Promise.all(files.map((f, i) => resilientUpload(f, `chaos-${i}.bin`)));
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < files.length; i++) expect((await coldRead(nodes[i].blobId!)).equals(files[i])).toBe(true);
    }
    const c = metrics.counters;
    console.log(
      "chaos summary",
      JSON.stringify({
        requestsPerBot: rt.driver.status().bots.map((b) => b.requests),
        tgErrors: c["tg.errors"],
        floodWaits: c["tg.floodWaits"],
        failovers: c["lb.failovers"],
        piecesResent: c["upload.piecesResent"],
        integrityMismatches: c["integrity.mismatches"],
        refetches: c["integrity.refetches"],
        filesVerified: c["integrity.filesVerified"],
      }),
    );
    expect(c["tg.errors"]).toBeGreaterThan(10);
    expect(c["tg.floodWaits"]).toBeGreaterThan(0);
    expect(c["lb.failovers"]).toBeGreaterThan(0); // failed reads moved to another bot
    expect(c["upload.piecesResent"]).toBeGreaterThan(0); // dropped pieces were detected and resent
    expect(c["integrity.mismatches"]).toBeGreaterThan(0); // bit rot was injected…
    expect(c["integrity.refetches"]).toBeGreaterThan(0); // …and healed by refetching
    expect(c["integrity.filesVerified"]).toBeGreaterThanOrEqual(files.length); // full reads verified whole-file SHA-256
  }, 180_000);

  it("keeps every bot in the rotation through the chaos", () => {
    const bots = rt.driver.status().bots;
    expect(bots.length).toBe(4);
    for (const b of bots) expect(b.state).toBe("ready");
    // Flood waits and faults constantly knock bots out of eligibility here, so the
    // read split is noise; latency steering is measured cleanly in steering.test.ts.
    expect(bots.map((b) => b.requests).filter((n) => n > 0).length).toBe(4);
    console.log("read bytes per bot", JSON.stringify(bots.map((b) => b.bytesDown)));
  });
});
