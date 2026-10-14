import "server-only";

/** FIFO counting semaphore. */
export class Semaphore {
  private waiters: (() => void)[] = [];
  active = 0;

  constructor(readonly limit: number) {}

  get pending() {
    return this.waiters.length;
  }

  get load() {
    return this.active + this.waiters.length;
  }

  acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Hands the slot directly to the next waiter, keeping `active` constant. */
  release() {
    const next = this.waiters.shift();
    if (next) next();
    else this.active--;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Runs `fn` over `items` with at most `limit` in flight; rejects on the first failure. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i], i);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
