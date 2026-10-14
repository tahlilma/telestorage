import "server-only";
import { makeZip, predictLength } from "client-zip";
import type { NextRequest } from "next/server";
import type { DriveNode } from "@/lib/types";
import { sql } from "./db";
import { contentDisposition, notFound } from "./http";
import { touch } from "./nodes";
import { storage } from "./storage";
import { loadThumbPack } from "./storage/backup";
import { loadBlob, openRangeStream, prefetchBlob } from "./storage/blobs";

/** Types a browser would execute or render as active content on our origin. */
const ACTIVE_CONTENT = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|text\/javascript|application\/javascript|application\/ecmascript)/i;

type Range = { start: number; end: number };

function parseRange(header: string | null, size: number): Range | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // multi-range or garbage → full response
  if (!m[1] && !m[2]) return "unsatisfiable";
  let start: number;
  let end: number;
  if (!m[1]) {
    const suffix = Number(m[2]);
    if (suffix === 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

export async function serveFile(
  req: NextRequest,
  node: DriveNode,
  opts: { download: boolean; cache: "private" | "share"; onServe?: () => void },
): Promise<Response> {
  if (node.kind !== "file" || !node.blobId) throw notFound("Not a file");
  const rt = await storage();
  const blob = loadBlob(node.blobId);
  if (!blob) throw notFound("File content is missing");

  const etag = `"${blob.id}"`;
  const mime = node.mime || "application/octet-stream";
  const inlineSafe = !ACTIVE_CONTENT.test(mime);
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    ETag: etag,
    "Last-Modified": new Date(node.createdAt).toUTCString(),
    // Content behind an id never changes, so browsers may cache it forever.
    "Cache-Control": opts.cache === "private" ? "private, max-age=31536000, immutable" : "private, max-age=3600",
    "Content-Type": opts.download || inlineSafe ? mime : "text/plain; charset=utf-8",
    "Content-Disposition": contentDisposition(opts.download ? "attachment" : "inline", node.name),
    "X-Content-Type-Options": "nosniff",
  });
  // RFC 9530: the SHA-256 of the whole file (on range responses too), so a
  // client assembling the file from parallel ranges can prove it got it right.
  if (blob.sha256) headers.set("Repr-Digest", `sha-256=:${Buffer.from(blob.sha256, "hex").toString("base64")}:`);
  // Sandbox user content so a malicious file can never script against this origin.
  // (PDF viewers refuse to run inside a sandbox, and PDFs cannot carry same-origin script.)
  if (mime !== "application/pdf") headers.set("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'unsafe-inline'");

  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });

  let range = parseRange(req.headers.get("range"), blob.size);
  const ifRange = req.headers.get("if-range");
  if (range && ifRange && ifRange !== etag) range = null;
  if (range === "unsatisfiable") {
    headers.set("Content-Range", `bytes */${blob.size}`);
    return new Response(null, { status: 416, headers });
  }

  const { start, end } = range ?? { start: 0, end: blob.size - 1 };
  headers.set("Content-Length", String(Math.max(0, end - start + 1)));
  if (range) headers.set("Content-Range", `bytes ${start}-${end}/${blob.size}`);

  if (start === 0) {
    touch(node.id);
    opts.onServe?.();
  }
  if (req.method === "HEAD") return new Response(null, { status: range ? 206 : 200, headers });
  // Owner reads outrank public share-link reads inside every bot connection's scheduler.
  const klass = opts.cache === "private" ? "owner" : "public";
  return new Response(openRangeStream(rt, blob, start, end, klass), { status: range ? 206 : 200, headers });
}

/** Streams a ZIP of the given entries with an exact Content-Length (stored, no recompression). */
export async function serveArchive(entries: { path: string; node: DriveNode }[], archiveName: string, klass: "owner" | "public" = "owner"): Promise<Response> {
  const rt = await storage();
  const seen = new Map<string, number>();
  const unique = (p: string) => {
    const n = seen.get(p.toLowerCase()) ?? 0;
    seen.set(p.toLowerCase(), n + 1);
    if (!n) return p;
    const dot = p.lastIndexOf(".");
    return dot > p.lastIndexOf("/") + 1 ? `${p.slice(0, dot)} (${n + 1})${p.slice(dot)}` : `${p} (${n + 1})`;
  };
  const items = entries.map(({ path, node }) => ({
    name: node.kind === "folder" ? `${unique(path)}/` : unique(path),
    node,
    blob: node.kind === "file" && node.blobId ? loadBlob(node.blobId) : null,
  }));

  const metadata = items.map((i) => (i.node.kind === "folder" ? { name: i.name } : { name: i.name, size: i.blob?.size ?? 0 }));
  const length = predictLength(metadata);

  async function* files() {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const lastModified = new Date(it.node.updatedAt);
      if (it.node.kind === "folder") {
        yield { name: it.name, lastModified };
        continue;
      }
      // Overlap the next file's first round trip with this file's transfer.
      const upcoming = items.slice(i + 1).find((x) => x.blob);
      if (upcoming?.blob) prefetchBlob(rt, upcoming.blob);
      const size = it.blob?.size ?? 0;
      yield {
        name: it.name,
        lastModified,
        size,
        input: it.blob && size > 0 ? openRangeStream(rt, it.blob, 0, size - 1, klass) : new ReadableStream({ start: (c) => c.close() }),
      };
    }
  }

  return new Response(makeZip(files(), { length }), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(length),
      "Content-Disposition": contentDisposition("attachment", archiveName.endsWith(".zip") ? archiveName : `${archiveName}.zip`),
      "Cache-Control": "no-store",
    },
  });
}

/** Serves a stored thumbnail with immutable caching. */
export async function thumbResponse(blobId: string, req: Request): Promise<Response> {
  const read = () => sql("SELECT mime, data, pack FROM thumbs WHERE blob_id = ?").get(blobId) as { mime: string; data: Buffer; pack: number | null } | undefined;
  let row = read();
  // Restored from a backup: the image itself waits in its pack in the channel.
  if (row && !row.data.length && row.pack !== null) {
    await loadThumbPack(await storage(), row.pack);
    row = read();
  }
  if (!row || !row.data.length) throw notFound("No thumbnail");
  const etag = `"t-${blobId}"`;
  const headers = { ETag: etag, "Content-Type": row.mime, "Cache-Control": "private, max-age=31536000, immutable" };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(new Uint8Array(row.data), { headers });
}
