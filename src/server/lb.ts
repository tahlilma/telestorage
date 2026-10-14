import "server-only";

/**
 * Load-balancing and flow-control primitives shared by the storage pool and
 * the HTTP layer. Everything here is transport-agnostic and unit tested.
 */

// ---------------------------------------------------------------------------
// Priorities
// ---------------------------------------------------------------------------

/** 0 = a user is waiting on this exact byte, 1 = streaming/uploads, 2 = background. */
export type Priority = 0 | 1 | 2;
export const Interactive: Priority = 0;
export const Normal: Priority = 1;
export const Background: Priority = 2;

/** A priority that can be raised while its task waits in a queue (e.g. readahead becoming the head block). */
export class PriorityToken {
  private listeners = new Set<() => void>();
  constructor(public priority: Priority) {}

  raise(to: Priority) {
    if (to >= this.priority) return;
    this.priority = to;
    for (const l of [...this.listeners]) l();
  }

  onRaise(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

// ---------------------------------------------------------------------------
// Peak-EWMA latency estimator (Finagle-style): jumps up instantly on a slow
// sample, decays back exponentially, so a degrading endpoint is avoided fast
// and forgiven gradually.
// ---------------------------------------------------------------------------

export class PeakEwma {
  private value: number;
  private stamp: number;
  samples = 0;

  constructor(
    private readonly tauMs = 10_000,
    initial = 50,
  ) {
    this.value = initial;
    this.stamp = performance.now();
  }

  observe(sample: number, now = performance.now()) {
    const elapsed = Math.max(0, now - this.stamp);
    this.stamp = now;
    this.samples++;
    if (sample > this.value) {
      this.value = sample;
      return;
    }
    const w = Math.exp(-elapsed / this.tauMs);
    this.value = this.value * w + sample * (1 - w);
  }

  get(): number {
    return this.value;
  }
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

export type BreakerState = "closed" | "open" | "half-open";

export class CircuitBreaker {
  state: BreakerState = "closed";
  private failures = 0;
  private openedAt = 0;
  private probeAt = 0;
  trips = 0;

  constructor(
    private readonly threshold = 4,
    private readonly cooldownMs = 10_000,
  ) {}

  /** Selection-time check that never consumes the half-open probe. */
  canAttempt(now = Date.now()): boolean {
    if (this.state === "closed") return true;
    if (this.state === "open") return now - this.openedAt >= this.cooldownMs;
    return now - this.probeAt >= this.cooldownMs; // a stuck probe is retried after a cooldown
  }

  /** Execution-time check: in half-open state only one probe is admitted at a time. */
  allow(now = Date.now()): boolean {
    if (this.state === "closed") return true;
    if (this.state === "open") {
      if (now - this.openedAt < this.cooldownMs) return false;
      this.state = "half-open";
      this.probeAt = now;
      return true;
    }
    if (now - this.probeAt >= this.cooldownMs) {
      this.probeAt = now;
      return true;
    }
    return false;
  }

  success() {
    this.failures = 0;
    this.state = "closed";
  }

  failure(now = Date.now()) {
    this.failures++;
    if (this.state === "half-open" || this.failures >= this.threshold) {
      if (this.state !== "open") this.trips++;
      this.state = "open";
      this.openedAt = now;
    }
  }
}

// ---------------------------------------------------------------------------
// Token bucket (proactive rate limiting, e.g. Telegram sendMedia flood limits)
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class TokenBucket {
  private tokens: number;
  private last = Date.now();
  private blockedUntil = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number,
  ) {
    this.tokens = burst;
  }

  private refill(now: number) {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.ratePerSec);
    this.last = now;
  }

  /** Milliseconds until a token is available (0 = now). */
  wait(now = Date.now()): number {
    this.refill(now);
    if (now < this.blockedUntil) return this.blockedUntil - now;
    return this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) / this.ratePerSec) * 1000);
  }

  tryTake(now = Date.now()): boolean {
    if (this.wait(now) > 0) return false;
    this.tokens -= 1;
    return true;
  }

  /** FIFO: callers are served in arrival order. */
  take(): Promise<void> {
    const next = this.chain.then(async () => {
      for (;;) {
        const ms = this.wait();
        if (ms === 0) {
          this.tokens -= 1;
          return;
        }
        await sleep(Math.min(ms, 5000));
      }
    });
    this.chain = next.catch(() => {});
    return next;
  }

  /** Server told us to back off (FLOOD_WAIT): drain and block. */
  penalize(seconds: number) {
    this.tokens = 0;
    this.blockedUntil = Math.max(this.blockedUntil, Date.now() + seconds * 1000);
  }

  get available() {
    this.refill(Date.now());
    return this.tokens;
  }
}

// ---------------------------------------------------------------------------
// Priority gate: a concurrency limit with strict priority classes, waiter
// promotion and anti-starvation aging.
// ---------------------------------------------------------------------------

interface Waiter {
  token: PriorityToken;
  queue: Priority;
  enqueuedAt: number;
  resolve: () => void;
  dispose: () => void;
}

export class PriorityGate {
  active = 0;
  private readonly queues: Waiter[][] = [[], [], []];
  /** Completed acquisitions per class (observability). */
  readonly served = [0, 0, 0];

  constructor(
    public limit: number,
    private readonly agingMs = 1500,
  ) {}

  get pending() {
    return this.queues[0].length + this.queues[1].length + this.queues[2].length;
  }

  get load() {
    return this.active + this.pending;
  }

  acquire(token: PriorityToken): Promise<void> {
    if (this.active < this.limit && this.pending === 0) {
      this.active++;
      this.served[token.priority]++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const w: Waiter = { token, queue: token.priority, enqueuedAt: performance.now(), resolve, dispose: () => {} };
      this.queues[w.queue].push(w);
      w.dispose = token.onRaise(() => {
        const q = this.queues[w.queue];
        const i = q.indexOf(w);
        if (i < 0) return;
        q.splice(i, 1);
        w.queue = token.priority;
        this.queues[w.queue].push(w);
      });
    });
  }

  release() {
    const next = this.pickNext();
    if (next) {
      next.dispose();
      this.served[next.queue]++;
      next.resolve(); // slot handed over; `active` unchanged
    } else {
      this.active = Math.max(0, this.active - 1);
    }
  }

  private pickNext(): Waiter | undefined {
    const now = performance.now();
    // Aging: a lower class that has waited long enough jumps the line once.
    for (let p = 2; p >= 1; p--) {
      const head = this.queues[p][0];
      if (head && now - head.enqueuedAt > this.agingMs * p) return this.queues[p].shift();
    }
    for (const q of this.queues) if (q.length) return q.shift();
    return undefined;
  }

  async run<T>(token: PriorityToken, fn: () => Promise<T>): Promise<T> {
    await this.acquire(token);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

// ---------------------------------------------------------------------------
// Power-of-two-choices with a peak-EWMA cost function.
// ---------------------------------------------------------------------------

export interface Balanceable {
  readonly key: string;
  /** Requests in flight + queued. */
  load(): number;
  /** Smoothed latency in ms. */
  latency(): number;
  /** Relative capacity (e.g. concurrency limit). */
  readonly capacity: number;
  /** Eligible for new work right now. */
  eligible(): boolean;
}

export const cost = (b: Balanceable) => ((b.latency() + 1) * (b.load() + 1)) / Math.max(1, b.capacity);

/**
 * Picks two random eligible candidates and returns the cheaper one. This gets
 * within a constant factor of "always pick the least loaded" while avoiding
 * the herd behaviour where every request piles onto the same idle endpoint.
 */
export function pickP2C<T extends Balanceable>(items: readonly T[], exclude?: ReadonlySet<string>, rand: () => number = Math.random): T | undefined {
  const pool = items.filter((i) => i.eligible() && !exclude?.has(i.key));
  if (pool.length === 0) return undefined;
  if (pool.length === 1) return pool[0];
  const i = Math.floor(rand() * pool.length);
  let j = Math.floor(rand() * (pool.length - 1));
  if (j >= i) j++;
  return cost(pool[i]) <= cost(pool[j]) ? pool[i] : pool[j];
}

// ---------------------------------------------------------------------------
// Hedge budget: duplicate a slow interactive read on a second endpoint, but
// never let hedges exceed a fixed share of traffic.
// ---------------------------------------------------------------------------

/**
 * Recent latency samples (ring buffer) for robust percentile estimates. Used
 * to decide when a request is "unusually slow" — unlike a peak-EWMA, one stall
 * barely moves the median.
 */
export class LatencyWindow {
  private readonly buf: Float64Array;
  private n = 0;
  private i = 0;
  private sorted: Float64Array | null = null;

  constructor(size = 256) {
    this.buf = new Float64Array(size);
  }

  record(ms: number) {
    this.buf[this.i] = ms;
    this.i = (this.i + 1) % this.buf.length;
    this.n = Math.min(this.n + 1, this.buf.length);
    this.sorted = null;
  }

  /** The q-quantile of recent samples, or null until there are enough to say. */
  quantile(q: number): number | null {
    if (this.n < 8) return null;
    this.sorted ??= this.buf.slice(0, this.n).sort();
    return this.sorted[Math.min(this.n - 1, Math.floor(q * this.n))];
  }
}

export class HedgeBudget {
  private requests = 0;
  private hedges = 0;
  private windowStart = Date.now();

  constructor(
    private readonly ratio = 0.1,
    private readonly floor = 3,
  ) {}

  private roll() {
    if (Date.now() - this.windowStart > 60_000) {
      this.requests = 0;
      this.hedges = 0;
      this.windowStart = Date.now();
    }
  }

  noteRequest() {
    this.roll();
    this.requests++;
  }

  tryHedge(): boolean {
    this.roll();
    if (this.hedges >= this.requests * this.ratio + this.floor) return false;
    this.hedges++;
    return true;
  }
}

// ---------------------------------------------------------------------------
// Weighted admission control (bytes in flight) with bounded queueing.
// ---------------------------------------------------------------------------

export class OverloadedError extends Error {
  constructor(readonly retryAfterSec: number) {
    super("Server is busy — retry shortly");
  }
}

interface WeightedWaiter {
  weight: number;
  resolve: (release: () => void) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class WeightedSemaphore {
  used = 0;
  rejected = 0;
  private waiters: WeightedWaiter[] = [];

  constructor(
    public capacity: number,
    private readonly maxQueue = 256,
  ) {}

  get queued() {
    return this.waiters.length;
  }

  acquire(weight: number, timeoutMs: number): Promise<() => void> {
    const w = Math.max(1, Math.min(weight, this.capacity));
    if (this.waiters.length === 0 && this.used + w <= this.capacity) {
      this.used += w;
      return Promise.resolve(this.releaser(w));
    }
    if (this.waiters.length >= this.maxQueue) {
      this.rejected++;
      return Promise.reject(new OverloadedError(2));
    }
    return new Promise((resolve, reject) => {
      const waiter: WeightedWaiter = {
        weight: w,
        resolve,
        reject,
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          this.rejected++;
          reject(new OverloadedError(Math.max(1, Math.ceil(timeoutMs / 4000))));
          this.drain();
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  private releaser(weight: number) {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.used -= weight;
      this.drain();
    };
  }

  private drain() {
    while (this.waiters.length && this.used + this.waiters[0].weight <= this.capacity) {
      const w = this.waiters.shift()!;
      clearTimeout(w.timer);
      this.used += w.weight;
      w.resolve(this.releaser(w.weight));
    }
  }
}
