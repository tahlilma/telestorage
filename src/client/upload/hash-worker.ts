/// <reference lib="webworker" />
import { createSHA256 } from "hash-wasm";
import { PIECE_SIZE, partSizes, windowsOfPart } from "@/lib/protocol";

/**
 * One pass over the file, off the main thread, producing:
 *   - the whole-file SHA-256 (content identity → dedup), and
 *   - one hash-tree root per part (piece → window → part, see protocol.ts),
 *     which the server uses to prove it reassembled exactly these bytes.
 * Memory stays at one 8 MiB read plus 32 bytes per part, so a 10 TB file is
 * hashed as comfortably as a 10 MB one. WASM SHA-256 also works in insecure
 * contexts (plain-HTTP LAN access), unlike WebCrypto.
 */
const cancelled = new Set<number>();

self.onmessage = async (e: MessageEvent<{ id: number; file?: File; partSize?: number; cancel?: boolean }>) => {
  const { id, file, partSize, cancel } = e.data;
  if (cancel) {
    cancelled.add(id);
    return;
  }
  if (!file || !partSize) return;
  try {
    const [whole, piece, windowHash, partHash] = await Promise.all([createSHA256(), createSHA256(), createSHA256(), createSHA256()]);
    whole.init();
    const sizes = partSizes(file.size, partSize);
    const roots = new Uint8Array(sizes.length * 32);
    let pos = 0;
    let lastPost = 0;
    for (let p = 0; p < sizes.length; p++) {
      const partEnd = pos + sizes[p];
      partHash.init();
      // A window is at most 16 pieces (8 MiB) and never crosses a part boundary: one read each.
      for (const pieces of windowsOfPart(sizes[p])) {
        if (cancelled.has(id)) {
          cancelled.delete(id);
          return;
        }
        const end = Math.min(partEnd, pos + pieces * PIECE_SIZE);
        const buf = new Uint8Array(await file.slice(pos, end).arrayBuffer());
        whole.update(buf);
        windowHash.init();
        for (let q = 0; q < buf.length; q += PIECE_SIZE) {
          piece.init();
          piece.update(buf.subarray(q, q + PIECE_SIZE));
          windowHash.update(piece.digest("binary"));
        }
        partHash.update(windowHash.digest("binary"));
        pos = end;
        const now = performance.now();
        if (now - lastPost > 120) {
          lastPost = now;
          self.postMessage({ id, progress: Math.min(1, pos / file.size) });
        }
      }
      roots.set(partHash.digest("binary"), p * 32);
    }
    self.postMessage({ id, sha256: whole.digest("hex"), parts: roots.buffer }, [roots.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
