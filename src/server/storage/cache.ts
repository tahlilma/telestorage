import "server-only";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import { PriorityToken } from "../lb";
import { log, metrics } from "../metrics";
import { IntegrityError } from "./types";

export interface CacheGetOptions {
  /** Store fetched blocks in the disk tier too. */
  persist: boolean;
  /** Checksum check applied to disk hits and fresh fetches. */
  verify?: (data: Buffer) => boolean;
  /** Priority of the caller (propagated to the fetch and raised on coalescing). */
  token: PriorityToken;
}

/** Byte-bounded LRU built on Map insertion order. */
class MemoryLru {
  private map = new Map<string, Buffer>();
  bytes = 0;

  constructor(readonly max: number) {}

  get size() {
    return this.map.size;
  }

  get(key: string): Buffer | undefined {
    const v = this.map.get(key);
    if (v) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: string, value: Buffer) {
    if (this.max <= 0 || value.length > this.max / 4) return;
    const old = this.map.get(key);
    if (old) {
      this.bytes -= old.length;
      this.map.delete(key);
    }
    this.map.set(key, value);
    this.bytes += value.length;
    for (const [k, v] of this.map) {
      if (this.bytes <= this.max) break;
      this.map.delete(k);
      this.bytes -= v.length;
    }
  }

  deletePrefix(prefix: string) {
    for (const [k, v] of this.map) {
      if (k.startsWith(prefix)) {
        this.map.delete(k);
        this.bytes -= v.length;
      }
    }
  }
}

/**
 * Size-capped on-disk LRU of storage blocks. The index lives in memory and is
 * rebuilt from the directory (ordered by mtime) on boot. Writes are atomic
 * (tmp + rename) and never block the response path.
 */
class DiskLru {
  private index = new Map<string, number>(); // key -> size, LRU ordered
  bytes = 0;
  private ready: Promise<void>;

  constructor(
    private dir: string,
    readonly max: number,
  ) {
    this.ready = this.max > 0 ? this.scan() : Promise.resolve();
  }

  get size() {
    return this.index.size;
  }

  private file(key: string) {
    // key = `${blobId}/${part}-${block}` → shard by blob id prefix
    return path.join(this.dir, key.slice(0, 2), key);
  }

  private async scan() {
    const entries: { key: string; size: number; mtime: number }[] = [];
    try {
      await fs.promises.mkdir(this.dir, { recursive: true });
      for (const shard of await fs.promises.readdir(this.dir)) {
        const shardDir = path.join(this.dir, shard);
        for (const blob of await fs.promises.readdir(shardDir).catch(() => [] as string[])) {
          const blobDir = path.join(shardDir, blob);
          for (const name of await fs.promises.readdir(blobDir).catch(() => [] as string[])) {
            if (name.endsWith(".tmp")) {
              void fs.promises.rm(path.join(blobDir, name), { force: true });
              continue;
            }
            const st = await fs.promises.stat(path.join(blobDir, name)).catch(() => null);
            if (st?.isFile()) entries.push({ key: `${blob}/${name}`, size: st.size, mtime: st.mtimeMs });
          }
        }
      }
    } catch (e) {
      log.warn("cache", `disk cache scan failed: ${(e as Error).message}`);
    }
    entries.sort((a, b) => a.mtime - b.mtime);
    for (const e of entries) {
      this.index.set(e.key, e.size);
      this.bytes += e.size;
    }
    if (entries.length) log.info("cache", `disk cache: ${entries.length} blocks, ${(this.bytes / 1048576).toFixed(0)} MiB`);
    this.evict();
  }

  async get(key: string): Promise<Buffer | null> {
    if (this.max <= 0) return null;
    await this.ready;
    const size = this.index.get(key);
    if (size === undefined) return null;
    try {
      const buf = await fs.promises.readFile(this.file(key));
      this.index.delete(key);
      this.index.set(key, size);
      return buf;
    } catch {
      this.index.delete(key);
      this.bytes -= size;
      return null;
    }
  }

  async put(key: string, data: Buffer) {
    if (this.max <= 0 || this.index.has(key)) return;
    await this.ready;
    const file = this.file(key);
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(tmp, data);
      await fs.promises.rename(tmp, file);
      this.index.set(key, data.length);
      this.bytes += data.length;
      this.evict();
    } catch {
      await fs.promises.rm(tmp, { force: true }).catch(() => {});
    }
  }

  private evict() {
    for (const [key, size] of this.index) {
      if (this.bytes <= this.max) break;
      this.index.delete(key);
      this.bytes -= size;
      void fs.promises.rm(this.file(key), { force: true }).catch(() => {});
    }
  }

  async delete(key: string) {
    await this.ready;
    const size = this.index.get(key);
    if (size === undefined) return;
    this.index.delete(key);
    this.bytes -= size;
    await fs.promises.rm(this.file(key), { force: true }).catch(() => {});
  }

  async deleteBlob(blobId: string) {
    await this.ready;
    for (const [key, size] of this.index) {
      if (key.startsWith(`${blobId}/`)) {
        this.index.delete(key);
        this.bytes -= size;
      }
    }
    await fs.promises.rm(path.join(this.dir, blobId.slice(0, 2), blobId), { recursive: true, force: true }).catch(() => {});
  }
}

export class BlockCache {
  readonly mem: MemoryLru;
  readonly disk: DiskLru;
  private inflight = new Map<string, { promise: Promise<Buffer>; token: PriorityToken }>();

  constructor() {
    const c = config();
    this.mem = new MemoryLru(c.cache.memoryBytes);
    this.disk = new DiskLru(c.cacheDir, c.cache.diskBytes);
  }

  get inflightCount() {
    return this.inflight.size;
  }

  /**
   * Returns the block from memory, then disk, then `load()`. Concurrent requests
   * for the same block (e.g. a video player's overlapping range requests) share
   * a single upstream fetch.
   */
  get(key: string, load: (token: PriorityToken) => Promise<Buffer>, opts: CacheGetOptions): Promise<Buffer> {
    const hit = this.mem.get(key);
    if (hit) {
      // Memory entries were verified on the way in; RAM is trusted.
      metrics.inc("cache.memHits");
      return Promise.resolve(hit);
    }
    const pending = this.inflight.get(key);
    if (pending) {
      metrics.inc("cache.coalesced");
      pending.token.raise(opts.token.priority); // an urgent reader joining a background fetch speeds it up
      return pending.promise;
    }
    const token = new PriorityToken(opts.token.priority);
    const p = (async () => {
      if (opts.persist) {
        const fromDisk = await this.disk.get(key);
        if (fromDisk) {
          if (!opts.verify || opts.verify(fromDisk)) {
            metrics.inc("cache.diskHits");
            this.mem.set(key, fromDisk);
            return fromDisk;
          }
          // Bit rot / torn write in the disk cache: drop it and refetch from storage.
          metrics.inc("integrity.cacheEvictions");
          log.warn("integrity", `disk cache block ${key} failed verification — evicted`);
          await this.disk.delete(key);
        }
      }
      metrics.inc("cache.misses");
      metrics.gauges.inflightBlocks++;
      try {
        for (let attempt = 0; ; attempt++) {
          const data = await load(token);
          if (!opts.verify || opts.verify(data)) {
            if (opts.verify) metrics.inc("integrity.blocksVerified");
            this.mem.set(key, data);
            if (opts.persist) void this.disk.put(key, data);
            return data;
          }
          metrics.inc("integrity.mismatches");
          log.warn("integrity", `block ${key} failed SHA-256 verification (attempt ${attempt + 1}) — refetching`);
          if (attempt >= 2) throw new IntegrityError(`Block ${key} keeps failing SHA-256 verification`);
          metrics.inc("integrity.refetches");
        }
      } finally {
        metrics.gauges.inflightBlocks--;
      }
    })();
    this.inflight.set(key, { promise: p, token });
    p.then(
      () => this.inflight.delete(key),
      () => this.inflight.delete(key),
    );
    return p;
  }

  async forgetBlob(blobId: string) {
    this.mem.deletePrefix(`${blobId}/`);
    await this.disk.deleteBlob(blobId);
  }

  stats() {
    return {
      memBytes: this.mem.bytes,
      memMax: this.mem.max,
      memEntries: this.mem.size,
      diskBytes: this.disk.bytes,
      diskMax: this.disk.max,
      diskEntries: this.disk.size,
      inflight: this.inflight.size,
    };
  }
}
