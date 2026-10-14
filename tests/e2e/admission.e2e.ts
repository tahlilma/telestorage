import { describe, expect, it } from "vitest";
import type { DriveNode } from "@/lib/types";
import { fileDigests, planChunks, sha, sliceFor } from "../support/upload-client";
import { Client, randomBytes, sleep, TIGHT_URL } from "./client";

/**
 * Traffic spike against a deliberately tight server (small upload buffer,
 * slow storage): the server must shed load with 503 + Retry-After instead of
 * buffering without bound or falling over, stay responsive, and every chunk
 * must still land once clients honour Retry-After.
 *
 * The global setup boots that server (UPLOAD_BUFFER_MB=16,
 * UPLOAD_QUEUE_TIMEOUT_MS=1000, SIM_BANDWIDTH_MBPS=2); against an external
 * server, set E2E_TIGHT_URL to one configured the same way.
 */
const TIGHT = TIGHT_URL;

describe.skipIf(!TIGHT)("admission control under a burst", () => {
  it("sheds with 503 + Retry-After, stays healthy, and converges", async () => {
    const c = await new Client(TIGHT!).login();
    const data = randomBytes(48 * 1024 * 1024);
    const init = await c.init("burst.bin", data.length);
    const { id, partSize } = init.body;
    const ranges = planChunks(data.length, partSize, 2 * 1024 * 1024);

    const statuses: number[] = [];
    const retryAfter: number[] = [];
    let healthMs = 0;
    const send = async (r: (typeof ranges)[number]) => {
      for (let attempt = 0; attempt < 40; attempt++) {
        const res = await c.putChunk(id, r.part, r.offset, sliceFor(data, partSize, r));
        statuses.push(res.status);
        if (res.status === 200) return;
        if (res.status !== 503) throw new Error(`unexpected ${res.status}: ${JSON.stringify(res.body)}`);
        const wait = Number(res.retryAfter);
        retryAfter.push(wait);
        await sleep(wait * 1000);
      }
      throw new Error("chunk never admitted");
    };
    const burst = Promise.all(ranges.map(send));
    // While the burst is queued, the rest of the server must stay snappy.
    await sleep(300);
    const t0 = performance.now();
    expect((await c.json("GET", "/api/health")).status).toBe(200);
    healthMs = performance.now() - t0;
    await burst;

    const shed = statuses.filter((s) => s === 503).length;
    console.log("admission", JSON.stringify({ chunks: ranges.length, requests: statuses.length, shed, retryAfter: [...new Set(retryAfter)], healthMs: Math.round(healthMs) }));
    expect(shed).toBeGreaterThan(0);
    expect(retryAfter.every((s) => Number.isFinite(s) && s >= 1)).toBe(true);
    expect(statuses.every((s) => s === 200 || s === 503)).toBe(true);
    expect(healthMs).toBeLessThan(1000);

    const done = await c.json<{ node: DriveNode }>("POST", `/api/uploads/${id}/complete`, fileDigests(data, partSize));
    expect(done.status).toBe(200);
    const back = await c.download(done.body.node);
    expect(sha(back.data).equals(sha(data))).toBe(true);

    const sys = await c.json<{ snapshot: { admission: { rejected: number } } }>("GET", "/api/system");
    expect(sys.body.snapshot.admission.rejected).toBeGreaterThan(0);
  }, 180_000);
});
