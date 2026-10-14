"use client";

export type Outcome =
  | { type: "ok"; ms: number; bytes: number }
  | { type: "overload"; retryAfterSec: number }
  | { type: "error" }
  | { type: "neutral" };

/**
 * Adaptive concurrency for chunk uploads, in the spirit of TCP congestion
 * control: additive increase while things are healthy, multiplicative
 * decrease on overload (503/429, honouring Retry-After) or network errors,
 * plus a latency-gradient brake — if per-MiB latency climbs well above the
 * best seen, requests are queueing somewhere and adding more only hurts.
 */
export class AdaptiveLimiter {
  limit: number;
  inflight = 0;
  pausedUntil = 0;
  private bestMsPerMiB = Infinity;
  private listeners = new Set<() => void>();

  constructor(
    readonly min = 2,
    readonly max = 8,
    initial = 4,
  ) {
    this.limit = initial;
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed() {
    for (const l of this.listeners) l();
  }

  get paused() {
    return Date.now() < this.pausedUntil;
  }

  /** Takes a slot if one is free right now. */
  tryAcquire(): ((o: Outcome) => void) | null {
    if (this.paused || this.inflight >= Math.floor(this.limit)) return null;
    this.inflight++;
    let done = false;
    return (o) => {
      if (done) return;
      done = true;
      this.inflight--;
      this.feedback(o);
    };
  }

  private feedback(o: Outcome) {
    if (o.type === "ok" && o.bytes > 0) {
      const perMiB = o.ms / (o.bytes / 1048576);
      this.bestMsPerMiB = Math.min(this.bestMsPerMiB * 1.002 + 0.01, perMiB); // slowly forget old bests
      if (perMiB > this.bestMsPerMiB * 2.5) this.limit = Math.max(this.min, this.limit - 0.25);
      else this.limit = Math.min(this.max, this.limit + 1 / this.limit);
    } else if (o.type === "overload") {
      this.limit = Math.max(this.min, this.limit * 0.6);
      this.pausedUntil = Math.max(this.pausedUntil, Date.now() + Math.max(1, o.retryAfterSec) * 1000);
    } else if (o.type === "error") {
      this.limit = Math.max(this.min, this.limit * 0.8);
    }
    this.changed();
  }
}
