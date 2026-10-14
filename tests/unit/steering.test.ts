import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Latency-aware balancing in isolation: four healthy bots, one of them 20×
 * slower. P2C over peak-EWMA latency × load must route reads away from it —
 * without starving it completely (it stays in rotation and is re-probed).
 */
process.env.STORAGE_DRIVER = "sim";
process.env.TG_PART_SIZE_MB = "2";
process.env.SIM_BOTS = "4";
process.env.SIM_CONNECTIONS = "2";
process.env.SIM_LATENCY_MS = "20";
process.env.SIM_JITTER_MS = "10";
process.env.SIM_SLOW_BOT = "3";
process.env.SIM_SLOW_FACTOR = "20";
process.env.SIM_COMMITS_PER_MINUTE = "6000";
process.env.TG_HEDGING = "false";

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

describe("latency steering", () => {
  it("hands the slow bot only a small share of reads", async () => {
    const { PriorityToken, Normal } = await import("@/server/lb");
    const { PIECE_SIZE } = await import("@/lib/protocol");
    const size = 2 * 1024 * 1024;
    const total = size / PIECE_SIZE;
    const refs: string[] = [];
    for (let p = 0; p < 4; p++) {
      const info = { blobId: `steer${p}`, index: 0, size, fileName: `steer${p}.bin`, caption: "" };
      const state = await rt.driver.beginPart(info);
      const data = Buffer.alloc(size, p + 1);
      for (let i = 0; i < total; i++) await rt.driver.writePiece(state, i, total, data.subarray(i * PIECE_SIZE, (i + 1) * PIECE_SIZE));
      refs.push(await rt.driver.commitPart(state, info, total));
    }
    const before = rt.driver.status().bots.map((b) => b.bytesDown);

    // 12 concurrent readers, 240 block reads of 1 MiB spread over every part.
    let n = 0;
    const reader = async () => {
      while (n < 240) {
        const i = n++;
        const buf = await rt.driver.readBlock(refs[i % refs.length], (i % 2) * 1024 * 1024, 1024 * 1024, { token: new PriorityToken(Normal) });
        expect(buf.length).toBe(1024 * 1024);
      }
    };
    await Promise.all(Array.from({ length: 12 }, reader));

    const read = rt.driver.status().bots.map((b, i) => b.bytesDown - before[i]);
    console.log("steering read bytes per bot", JSON.stringify(read));
    const fastest = Math.min(read[0], read[1], read[2]);
    expect(read[3]).toBeLessThan(fastest * 0.35);
  }, 60_000);
});
