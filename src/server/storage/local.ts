import "server-only";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config, PIECE_SIZE } from "../config";
import { GoneError, type DriverStatus, type PartInfo, type PartUploadState, type StorageDriver } from "./types";

/**
 * Stores parts as plain files under DATA_DIR/blobs. Used for development and
 * tests when Telegram credentials are absent; it exercises the exact same
 * upload/stream/cache/encryption/integrity pipeline as the Telegram driver.
 */
export class LocalDriver implements StorageDriver {
  readonly name = "local" as const;
  readonly cacheable = false;
  private dir = config().localBlobDir;

  async init() {
    await fs.promises.mkdir(this.dir, { recursive: true });
  }

  async stop() {}

  private file(name: string) {
    if (!/^[\w.-]+$/.test(name)) throw new Error("Invalid local part name");
    return path.join(this.dir, name);
  }

  async beginPart(info: PartInfo): Promise<PartUploadState> {
    // A nonce per attempt: a part that is redone (e.g. after a checksum mismatch)
    // must never share a file name with a superseded copy that GC will delete.
    const name = `${info.blobId}.${info.index}.${crypto.randomBytes(4).toString("hex")}`;
    const fh = await fs.promises.open(this.file(`${name}.tmp`), "w");
    await fh.truncate(info.size);
    await fh.close();
    return { name };
  }

  async writePiece(state: PartUploadState, pieceIndex: number, _total: number, data: Buffer) {
    const fh = await fs.promises.open(this.file(`${state.name}.tmp`), "r+");
    try {
      await fh.write(data, 0, data.length, pieceIndex * PIECE_SIZE);
    } finally {
      await fh.close();
    }
  }

  async commitPart(state: PartUploadState): Promise<string> {
    const name = String(state.name);
    await fs.promises.rename(this.file(`${name}.tmp`), this.file(name));
    return JSON.stringify({ f: name });
  }

  async abortPart(state: PartUploadState) {
    await fs.promises.rm(this.file(`${state.name}.tmp`), { force: true });
  }

  async readBlock(ref: string, offset: number, length: number): Promise<Buffer> {
    const { f } = JSON.parse(ref) as { f: string };
    let fh: fs.promises.FileHandle;
    try {
      fh = await fs.promises.open(this.file(f), "r");
    } catch {
      throw new GoneError(`Stored part ${f} is missing`);
    }
    try {
      const buf = Buffer.allocUnsafe(length);
      const { bytesRead } = await fh.read(buf, 0, length, offset);
      return bytesRead === length ? buf : buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  }

  async deleteParts(refs: string[]) {
    await Promise.all(refs.map((ref) => fs.promises.rm(this.file((JSON.parse(ref) as { f: string }).f), { force: true })));
  }

  status(): DriverStatus {
    return { bots: [], channel: null };
  }

  /** Test hook: does a committed part still exist on disk? */
  exists(ref: string) {
    return fs.existsSync(this.file((JSON.parse(ref) as { f: string }).f));
  }
}
