import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Background,
  CircuitBreaker,
  HedgeBudget,
  Interactive,
  Normal,
  OverloadedError,
  PeakEwma,
  PriorityGate,
  PriorityToken,
  TokenBucket,
  WeightedSemaphore,
  pickP2C,
  type Balanceable,
} from "@/server/lb";

afterEach(() => {
  vi.useRealTimers();
});

describe("PriorityToken", () => {
  it("only notifies when the priority actually rises", () => {
    const t = new PriorityToken(Background);
    const seen: number[] = [];
    t.onRaise(() => seen.push(t.priority));
    t.raise(Background);
    t.raise(Normal);
    t.raise(Background); // lowering is ignored
    t.raise(Interactive);
    expect(seen).toEqual([Normal, Interactive]);
  });
});

describe("PeakEwma", () => {
  it("jumps to peaks immediately and decays back over time", () => {
    const e = new PeakEwma(1000, 10);
    e.observe(500, 0);
    expect(e.get()).toBe(500);
    e.observe(10, 1000); // one tau later: ~63% of the way back
    expect(e.get()).toBeGreaterThan(150);
    expect(e.get()).toBeLessThan(200);
    for (let t = 2000; t < 10_000; t += 1000) e.observe(10, t);
    expect(e.get()).toBeLessThan(15);
  });
});

describe("CircuitBreaker", () => {
  it("opens after the threshold, admits one probe after cooldown, closes on success", () => {
    const b = new CircuitBreaker(3, 1000);
    b.failure(0);
    b.failure(0);
    expect(b.state).toBe("closed");
    b.failure(0);
    expect(b.state).toBe("open");
    expect(b.allow(500)).toBe(false);
    expect(b.canAttempt(500)).toBe(false);
    expect(b.canAttempt(1000)).toBe(true);
    expect(b.allow(1000)).toBe(true); // the probe
    expect(b.state).toBe("half-open");
    expect(b.allow(1001)).toBe(false); // only one probe at a time
    b.success();
    expect(b.state).toBe("closed");
    expect(b.allow(1002)).toBe(true);
  });

  it("re-opens when the probe fails and retries a stuck probe after cooldown", () => {
    const b = new CircuitBreaker(1, 1000);
    b.failure(0);
    expect(b.allow(1000)).toBe(true);
    b.failure(1000);
    expect(b.state).toBe("open");
    expect(b.allow(1500)).toBe(false);
    expect(b.allow(2000)).toBe(true);
    // probe never reports back:
    expect(b.allow(2500)).toBe(false);
    expect(b.allow(3000)).toBe(true);
    expect(b.trips).toBe(2); // initial trip + the failed probe re-opening it
  });
});

describe("TokenBucket", () => {
  it("allows a burst, then paces at the configured rate", () => {
    vi.useFakeTimers({ now: 0 });
    const b = new TokenBucket(2, 3);
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(false);
    vi.setSystemTime(499);
    expect(b.tryTake()).toBe(false);
    vi.setSystemTime(500);
    expect(b.tryTake()).toBe(true);
  });

  it("serves waiters in FIFO order and honours penalties", async () => {
    vi.useFakeTimers({ now: 0 });
    const b = new TokenBucket(10, 1);
    const order: number[] = [];
    const ps = [1, 2, 3].map((n) => b.take().then(() => order.push(n)));
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all(ps);
    expect(order).toEqual([1, 2, 3]);

    b.penalize(5);
    let done = false;
    void b.take().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(4000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1500);
    expect(done).toBe(true);
  });
});

describe("PriorityGate", () => {
  it("enforces the limit and serves higher priorities first", async () => {
    const g = new PriorityGate(1, 60_000);
    const order: string[] = [];
    await g.acquire(new PriorityToken(Normal)); // occupies the only slot
    const bg = g.acquire(new PriorityToken(Background)).then(() => order.push("background"));
    const norm = g.acquire(new PriorityToken(Normal)).then(() => order.push("normal"));
    const inter = g.acquire(new PriorityToken(Interactive)).then(() => order.push("interactive"));
    expect(g.pending).toBe(3);
    g.release();
    await inter;
    g.release();
    await norm;
    g.release();
    await bg;
    expect(order).toEqual(["interactive", "normal", "background"]);
    g.release();
    expect(g.active).toBe(0);
  });

  it("promotes a queued task when its token is raised", async () => {
    const g = new PriorityGate(1, 60_000);
    await g.acquire(new PriorityToken(Normal));
    const order: string[] = [];
    const lazy = new PriorityToken(Background);
    const a = g.acquire(new PriorityToken(Normal)).then(() => order.push("normal"));
    const b = g.acquire(lazy).then(() => order.push("promoted"));
    lazy.raise(Interactive);
    g.release();
    await b;
    g.release();
    await a;
    expect(order).toEqual(["promoted", "normal"]);
  });

  it("ages long-waiting background work ahead of fresh interactive work", async () => {
    vi.useFakeTimers({ now: 0, toFake: ["performance", "Date", "setTimeout"] });
    const g = new PriorityGate(1, 100);
    await g.acquire(new PriorityToken(Normal));
    const order: string[] = [];
    const bg = g.acquire(new PriorityToken(Background)).then(() => order.push("background"));
    vi.advanceTimersByTime(500); // background has waited > agingMs * 2
    const it = g.acquire(new PriorityToken(Interactive)).then(() => order.push("interactive"));
    g.release();
    await bg;
    g.release();
    await it;
    expect(order).toEqual(["background", "interactive"]);
  });
});

function endpoint(key: string, latency: number, load: number, eligible = true): Balanceable {
  return { key, capacity: 8, latency: () => latency, load: () => load, eligible: () => eligible };
}

describe("pickP2C", () => {
  it("never picks ineligible or excluded endpoints", () => {
    const eps = [endpoint("a", 10, 0, false), endpoint("b", 10, 0), endpoint("c", 10, 0)];
    for (let i = 0; i < 200; i++) {
      const p = pickP2C(eps, new Set(["c"]));
      expect(p?.key).toBe("b");
    }
    expect(pickP2C([endpoint("x", 1, 0, false)])).toBeUndefined();
  });

  it("steers traffic away from slow and busy endpoints", () => {
    const eps = [endpoint("fast", 20, 1), endpoint("slow", 400, 1), endpoint("busy", 20, 30), endpoint("ok", 25, 2)];
    const counts: Record<string, number> = {};
    for (let i = 0; i < 4000; i++) {
      const k = pickP2C(eps)!.key;
      counts[k] = (counts[k] ?? 0) + 1;
    }
    expect(counts.slow ?? 0).toBe(0); // the costliest endpoint loses every pairing
    // "busy" only wins when paired with "slow": 1 of 6 pairs → ~667 of 4000.
    expect(counts.busy).toBeGreaterThan(450);
    expect(counts.busy).toBeLessThan(900);
    expect(counts.fast).toBeGreaterThan(counts.ok); // cheapest wins every pairing it is in
  });
});

describe("HedgeBudget", () => {
  it("caps hedges at the configured ratio plus a small floor", () => {
    const h = new HedgeBudget(0.1, 2);
    for (let i = 0; i < 100; i++) h.noteRequest();
    let granted = 0;
    for (let i = 0; i < 100; i++) if (h.tryHedge()) granted++;
    expect(granted).toBe(12);
  });
});

describe("WeightedSemaphore", () => {
  it("admits by weight in FIFO order", async () => {
    const s = new WeightedSemaphore(10);
    const r1 = await s.acquire(6, 1000);
    const order: string[] = [];
    const p2 = s.acquire(6, 1000).then((r) => {
      order.push("second");
      return r;
    });
    const p3 = s.acquire(1, 1000).then((r) => {
      order.push("third");
      return r;
    });
    // third would fit, but FIFO keeps it behind second (no barging)
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([]);
    r1();
    const r2 = await p2;
    const r3 = await p3;
    expect(order).toEqual(["second", "third"]);
    expect(s.used).toBe(7);
    r2();
    r3();
    r3(); // double release is harmless
    expect(s.used).toBe(0);
  });

  it("rejects with Retry-After when the wait times out or the queue is full", async () => {
    const s = new WeightedSemaphore(4, 1);
    const hold = await s.acquire(4, 1000);
    const waiting = s.acquire(1, 50);
    await expect(s.acquire(1, 50)).rejects.toBeInstanceOf(OverloadedError); // queue full
    await expect(waiting).rejects.toBeInstanceOf(OverloadedError); // timed out
    expect(s.rejected).toBe(2);
    hold();
    expect(s.used).toBe(0);
  });
});
