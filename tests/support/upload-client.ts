import crypto from "node:crypto";
import { PIECE_SIZE, WINDOW_SIZE, partSizes, windowLayout, type MissingRange } from "@/lib/protocol";

export const sha = (b: Buffer | Uint8Array) => crypto.createHash("sha256").update(b).digest();
export const body = (b: Buffer) => new Response(new Uint8Array(b)).body!;

/** What the browser's hash worker produces: whole-file SHA-256 + one hash-tree root per part. */
export function fileDigests(data: Buffer, partSize: number) {
  const sizes = partSizes(data.length, partSize);
  const parts = sizes.map((bytes, part) => {
    const start = part * partSize;
    const root = crypto.createHash("sha256");
    for (let first = 0, left = Math.max(1, Math.ceil(bytes / PIECE_SIZE)); left > 0; left -= 16, first += 16) {
      const win = crypto.createHash("sha256");
      for (let i = first; i < first + Math.min(16, left); i++) {
        const s = start + i * PIECE_SIZE;
        win.update(sha(data.subarray(s, Math.min(s + PIECE_SIZE, start + bytes))));
      }
      root.update(win.digest());
    }
    return root.digest("hex");
  });
  return { sha256: sha(data).toString("hex"), parts };
}

/** The proof older clients send: every window hash. Still accepted. */
export function legacyDigests(data: Buffer, partSize: number) {
  const sizes = partSizes(data.length, partSize);
  const windows = windowLayout(data.length, partSize).map((w) => {
    const h = crypto.createHash("sha256");
    const partStart = w.part * partSize;
    const partEnd = partStart + sizes[w.part];
    for (let i = w.firstPiece; i < w.firstPiece + w.pieces; i++) {
      const start = partStart + i * PIECE_SIZE;
      h.update(sha(data.subarray(start, Math.min(start + PIECE_SIZE, partEnd))));
    }
    return h.digest("hex");
  });
  return { sha256: sha(data).toString("hex"), windows };
}

export function planChunks(size: number, partSize: number, chunkSize = WINDOW_SIZE): MissingRange[] {
  const out: MissingRange[] = [];
  partSizes(size, partSize).forEach((bytes, part) => {
    for (let off = 0; off < bytes; off += chunkSize) out.push({ part, offset: off, length: Math.min(chunkSize, bytes - off) });
  });
  return out;
}

export function shuffle<T>(xs: T[], seed = 7): T[] {
  const a = [...xs];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const sliceFor = (data: Buffer, partSize: number, r: MissingRange) =>
  data.subarray(r.part * partSize + r.offset, r.part * partSize + r.offset + r.length);
