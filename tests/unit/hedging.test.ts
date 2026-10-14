import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Tail-latency hedging: bots that are usually fast but occasionally stall for
 * 1.5 s. Interactive reads should be rescued by a duplicate request to a
 * different bot instead of waiting out the stall. The stall rate stays under
 * the 10 % hedge budget, and the base latency sits well above event-loop noise
 * from parallel test files, so the outcome doesn't depend on machine load.
 */
process.env.STORAGE_DRIVER = "sim";
process.env.TG_PART_SIZE_MB = "8";
process.env.SIM_BOTS = "3";
process.env.SIM_CONNECTIONS = "2";
process.env.SIM_LATENCY_MS = "40";
process.env.SIM_JITTER_MS = "10";
process.env.SIM_STALL_RATE = "0.06";
process.env.SIM_STALL_MS = "1500";
process.env.SIM_COMMITS_PER_MINUTE = "6000";

let rt: import("@/server/storage").Runtime;
let shutdown: () => Promise<void>;

beforeAll(async () => {
  const s = await import("@/server/storage");
  rt = await s.storage();
  shutdown = s.shutdownStorage;
});

afterAll(async () => {
  await shutdown();
});

describe("hedged reads", () => {
  it("rescues stalled interactive reads with a second bot", async () => {
    const { PriorityToken, Interactive } = await import("@/server/lb");
    const { metrics } = await import("@/server/metrics");
    const { PIECE_SIZE } = await import("@/lib/protocol");
    // Store one 8 MiB part directly through the pool.
    const info = { blobId: "hedge", index: 0, size: 8 * 1024 * 1024, fileName: "hedge.bin", caption: "" };
    const state = await rt.driver.beginPart(info);
    const total = info.size / PIECE_SIZE;
    const data = Buffer.alloc(info.size, 7);
    for (let i = 0; i < total; i++) await rt.driver.writePiece(state, i, total, data.subarray(i * PIECE_SIZE, (i + 1) * PIECE_SIZE));
    const ref = await rt.driver.commitPart(state, info, total);

    const latencies: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t0 = performance.now();
      const buf = await rt.driver.readBlock(ref, (i % 8) * 1024 * 1024, 1024 * 1024, { token: new PriorityToken(Interactive) });
      latencies.push(performance.now() - t0);
      expect(buf.length).toBe(1024 * 1024);
    }
    latencies.sort((a, b) => a - b);
    const p95 = latencies[Math.floor(latencies.length * 0.95)];
    const stalled = latencies.filter((ms) => ms > 1000).length;
    console.log(
      "hedging",
      JSON.stringify({ hedges: metrics.counters["lb.hedges"], wins: metrics.counters["lb.hedgeWins"], p50: Math.round(latencies[100]), p95: Math.round(p95), max: Math.round(latencies.at(-1)!), stalled }),
    );
    expect(metrics.counters["lb.hedges"]).toBeGreaterThan(0);
    expect(metrics.counters["lb.hedgeWins"]).toBeGreaterThan(0);
    // ~6 % of reads (≈12) stall for 1.5 s. Hedging must rescue nearly all of them:
    // only a stall whose hedge also stalls (≈0.4 % of reads) may get through.
    expect(stalled).toBeLessThanOrEqual(3);
    expect(p95).toBeLessThan(800);
  }, 120_000);
});
