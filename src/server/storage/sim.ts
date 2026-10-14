import "server-only";
import fs from "node:fs";
import path from "node:path";
import { PIECE_SIZE, config } from "../config";
import { sleep } from "../sem";
import { PoolDriver, type Transport } from "./pool";
import { FloodWaitError, GoneError, TransientError, type ChannelPost } from "./types";

export interface SimOptions {
  dir: string;
  connections: number;
  latencyMs: number;
  jitterMs: number;
  /** Per-connection link speed in bytes/s (0 = unlimited). */
  bandwidthBps: number;
  /** Probability that any call fails with a transient error. */
  faultRate: number;
  /** Probability that a commit triggers a flood wait (uploads: a tenth of that). */
  floodRate: number;
  floodSeconds: number;
  /** Probability that a read returns a corrupted byte. */
  corruptRate: number;
  /** Probability that an uploaded piece is silently lost (commit then reports it missing). */
  dropRate: number;
  /** Latency multiplier for this bot (to exercise load balancing). */
  slowFactor: number;
  /** Probability that a call stalls for `stallMs` (tail latency, to exercise hedging). */
  stallRate: number;
  stallMs: number;
}

/**
 * Opens a file for positional writes without ever truncating it, even when
 * several pieces race to create it (r+ → exclusive create → r+ again).
 */
async function openForWrite(file: string): Promise<fs.promises.FileHandle> {
  try {
    return await fs.promises.open(file, "r+");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  try {
    return await fs.promises.open(file, "wx+");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    return fs.promises.open(file, "r+");
  }
}

/** Message ids are shared by every simulated bot, like messages in one Telegram channel. */
let nextMessageId = 0;
function allocateMessageId(dir: string): number {
  if (nextMessageId === 0) {
    let max = 0;
    for (const f of fs.readdirSync(dir)) {
      const m = /^msg-(\d+)(?:\.json)?$/.exec(f);
      if (m) max = Math.max(max, Number(m[1]));
    }
    nextMessageId = max + 1;
  }
  return nextMessageId++;
}

/**
 * Takes the next id by creating its caption file exclusively, so two servers
 * sharing one simulated channel (as two real ones can share a channel) never
 * hand out the same message id.
 */
async function reserveMessageId(dir: string, meta: string): Promise<number> {
  for (;;) {
    const id = allocateMessageId(dir);
    try {
      await fs.promises.writeFile(path.join(dir, `msg-${id}.json`), meta, { flag: "wx" });
      return id;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      nextMessageId = 0; // someone else is posting too: look again
    }
  }
}

/**
 * A storage "bot" backed by local files that behaves like Telegram where it
 * matters for the pool: per-call latency, a bandwidth-limited link per
 * connection, flood waits, transient failures, lost pieces and bit rot.
 */
export class SimTransport implements Transport {
  readonly id: string;
  readonly connections: number;
  label: string;
  dcId: number;
  private floodUntil = 0;
  private started = false;
  private readonly pipeFreeAt: number[];
  private readonly received = new Map<string, Set<number>>();

  constructor(
    readonly index: number,
    private readonly o: SimOptions,
  ) {
    this.id = `sim${index + 1}`;
    this.label = `@sim_pilot_${index + 1}`;
    this.dcId = (index % 5) + 1;
    this.connections = o.connections;
    this.pipeFreeAt = new Array(o.connections).fill(0);
  }

  async start() {
    await fs.promises.mkdir(this.o.dir, { recursive: true });
    await sleep(this.o.latencyMs);
    this.started = true;
  }

  async stop() {
    this.started = false;
  }

  connected() {
    return this.started;
  }

  /** Latency + serialised transfer time on this connection's link + injected faults. */
  private async simulate(conn: number, bytes: number, op: "read" | "write" | "commit" | "meta") {
    const now = Date.now();
    if (this.floodUntil > now) throw new FloodWaitError(Math.ceil((this.floodUntil - now) / 1000), `FLOOD_WAIT_${Math.ceil((this.floodUntil - now) / 1000)}`);
    const floodChance = op === "commit" ? this.o.floodRate : op === "write" ? this.o.floodRate / 10 : 0;
    if (floodChance && Math.random() < floodChance) {
      this.floodUntil = now + this.o.floodSeconds * 1000;
      throw new FloodWaitError(this.o.floodSeconds, `FLOOD_WAIT_${this.o.floodSeconds}`);
    }
    let wait = (this.o.latencyMs + Math.random() * this.o.jitterMs) * this.o.slowFactor;
    if (this.o.stallRate && Math.random() < this.o.stallRate) wait += this.o.stallMs;
    if (this.o.bandwidthBps > 0 && bytes > 0) {
      const transferMs = (bytes / this.o.bandwidthBps) * 1000 * this.o.slowFactor;
      const start = Math.max(now, this.pipeFreeAt[conn]);
      this.pipeFreeAt[conn] = start + transferMs;
      wait += this.pipeFreeAt[conn] - now;
    }
    await sleep(wait);
    if (!this.started) throw new TransientError("SIM_DISCONNECTED");
    if (this.o.faultRate && Math.random() < this.o.faultRate) throw new TransientError("SIM_TIMEOUT");
  }

  private tmp(fileId: string) {
    return path.join(this.o.dir, `up-${this.id}-${fileId}.tmp`);
  }

  async uploadPiece(conn: number, fileId: string, piece: number, _total: number, _big: boolean, bytes: Buffer) {
    await this.simulate(conn, bytes.length, "write");
    if (this.o.dropRate && Math.random() < this.o.dropRate) return; // acknowledged but lost, like a dropped MTProto part
    const fh = await openForWrite(this.tmp(fileId));
    try {
      await fh.write(bytes, 0, bytes.length, piece * PIECE_SIZE);
    } finally {
      await fh.close();
    }
    let set = this.received.get(fileId);
    if (!set) this.received.set(fileId, (set = new Set()));
    set.add(piece);
  }

  async commit(conn: number, fileId: string, totalPieces: number, _big: boolean, fileName: string, caption: string) {
    await this.simulate(conn, 0, "commit");
    const got = this.received.get(fileId) ?? new Set<number>();
    for (let i = 0; i < totalPieces; i++) {
      if (!got.has(i)) throw new Error(`FILE_PART_${i}_MISSING`);
    }
    // Caption first: a post never exists without what it says about itself.
    const id = await reserveMessageId(this.o.dir, JSON.stringify({ caption, fileName }));
    await fs.promises.rename(this.tmp(fileId), path.join(this.o.dir, `msg-${id}`));
    this.received.delete(fileId);
    return JSON.stringify({ m: id });
  }

  async readBlock(conn: number, ref: string, offset: number, length: number): Promise<Buffer> {
    const { m } = JSON.parse(ref) as { m: number };
    await this.simulate(conn, length, "read");
    let fh: fs.promises.FileHandle;
    try {
      fh = await fs.promises.open(path.join(this.o.dir, `msg-${m}`), "r");
    } catch {
      throw new GoneError(`Message ${m} is missing (deleted from the channel?)`);
    }
    try {
      const buf = Buffer.allocUnsafe(length);
      const { bytesRead } = await fh.read(buf, 0, length, offset);
      const out = bytesRead === length ? buf : buf.subarray(0, bytesRead);
      if (this.o.corruptRate && out.length && Math.random() < this.o.corruptRate) {
        const bad = Buffer.from(out);
        bad[Math.floor(Math.random() * bad.length)] ^= 0x5a;
        return bad;
      }
      return out;
    } finally {
      await fh.close();
    }
  }

  async deleteRefs(conn: number, refs: string[]) {
    await this.simulate(conn, 0, "meta");
    await Promise.all(
      refs.flatMap((r) => {
        const m = (JSON.parse(r) as { m: number }).m;
        return [fs.promises.rm(path.join(this.o.dir, `msg-${m}`), { force: true }), fs.promises.rm(path.join(this.o.dir, `msg-${m}.json`), { force: true })];
      }),
    );
  }

  async pin(conn: number, ref: string) {
    await this.simulate(conn, 0, "meta");
    await fs.promises.writeFile(path.join(this.o.dir, "pinned.json"), JSON.stringify({ m: (JSON.parse(ref) as { m: number }).m }));
  }

  async pinnedPost(conn: number): Promise<ChannelPost | null> {
    await this.simulate(conn, 0, "meta");
    return simPinned(this.o.dir);
  }

  async editCaption(conn: number, ref: string, caption: string) {
    await this.simulate(conn, 0, "meta");
    const meta = path.join(this.o.dir, `msg-${(JSON.parse(ref) as { m: number }).m}.json`);
    const current = JSON.parse(await fs.promises.readFile(meta, "utf8")) as { caption: string; fileName: string | null };
    await fs.promises.writeFile(meta, JSON.stringify({ ...current, caption }));
  }

  channel() {
    return { id: "simulated", title: "Simulated channel" };
  }

  /** Test hook: is a stored message present on "Telegram"? */
  static exists(dir: string, ref: string) {
    return fs.existsSync(path.join(dir, `msg-${(JSON.parse(ref) as { m: number }).m}`));
  }
}

/** A simulated post as recovery sees it (no latency: it's the "channel" itself). */
export function simPost(dir: string, id: number): ChannelPost | null {
  const file = path.join(dir, `msg-${id}`);
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return null;
  }
  let meta: { caption?: string; fileName?: string | null } = {};
  try {
    meta = JSON.parse(fs.readFileSync(`${file}.json`, "utf8")) as typeof meta;
  } catch {
    /* posted before captions were kept */
  }
  return { id, ref: JSON.stringify({ m: id }), caption: meta.caption ?? "", size, fileName: meta.fileName ?? null };
}

export function simPinned(dir: string): ChannelPost | null {
  try {
    const { m } = JSON.parse(fs.readFileSync(path.join(dir, "pinned.json"), "utf8")) as { m: number };
    return simPost(dir, m);
  } catch {
    return null;
  }
}

export function createSimDriver(): PoolDriver {
  const c = config();
  const s = c.sim;
  const transports = Array.from(
    { length: s.bots },
    (_, i) =>
      new SimTransport(i, {
        dir: c.simDir,
        connections: s.connections,
        latencyMs: s.latencyMs,
        jitterMs: s.jitterMs,
        bandwidthBps: s.bandwidthBps,
        faultRate: s.faultRate,
        floodRate: s.floodRate,
        floodSeconds: s.floodSeconds,
        corruptRate: s.corruptRate,
        dropRate: s.dropRate,
        slowFactor: i === s.slowBot ? s.slowFactor : 1,
        stallRate: s.stallRate,
        stallMs: s.stallMs,
      }),
  );
  return new PoolDriver("sim", transports, {
    perConnectionConcurrency: c.tg.connectionConcurrency,
    commitsPerMinute: s.commitsPerMinute,
    commitBurst: 8,
    hedging: c.tg.hedging,
  });
}
