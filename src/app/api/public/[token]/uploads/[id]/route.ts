import { badRequest, route } from "@/server/http";
import { resolveShare } from "@/server/shares";
import { storage } from "@/server/storage";
import { abortUpload, parseDigest, partsInFlight, requireRequestUpload, uploadStatus, writeChunk } from "@/server/storage/uploads";

type Ctx = RouteContext<"/api/public/[token]/uploads/[id]">;

/** Resolves the request and checks the session was started through it. */
async function scoped(req: Parameters<Parameters<typeof route<Ctx>>[0]>[0], ctx: Ctx) {
  const { token, id } = await ctx.params;
  const r = resolveShare(req, token, { kind: "request" });
  requireRequestUpload(id, r.row.id);
  return id;
}

/** GET — what's still missing (for resuming). Only byte ranges: no names, no folder. */
export const GET = route<Ctx>(
  async (req, ctx) => {
    const id = await scoped(req, ctx);
    const { state, size, partSize, partCount, pieceSize, chunkSize, missing } = uploadStatus(id, { coarse: req.nextUrl.searchParams.get("coarse") === "1" });
    return Response.json(
      { state, size, partSize, partCount, pieceSize, chunkSize, missing, partsInFlight: partsInFlight(await storage()) },
      { headers: { "Cache-Control": "no-store" } },
    );
  },
  { auth: false },
);

/** PUT ?part=&offset= — one chunk, with its SHA-256 Content-Digest. */
export const PUT = route<Ctx>(
  async (req, ctx) => {
    const id = await scoped(req, ctx);
    const part = Number(req.nextUrl.searchParams.get("part"));
    const offset = Number(req.nextUrl.searchParams.get("offset"));
    if (!Number.isInteger(part) || !Number.isInteger(offset)) throw badRequest("part and offset are required");
    const lengthHeader = req.headers.get("content-length");
    const contentLength = lengthHeader !== null && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : null;
    const digest = parseDigest(req.headers.get("content-digest"), req.headers.get("x-chunk-sha256"));
    // Visitors must prove every chunk: a digest is required.
    if (!digest) throw badRequest("Content-Digest is required");
    return Response.json(await writeChunk(await storage(), id, part, offset, req.body, { digest, contentLength }));
  },
  { auth: false },
);

/** DELETE — the visitor cancels. */
export const DELETE = route<Ctx>(
  async (req, ctx) => {
    const id = await scoped(req, ctx);
    return Response.json(await abortUpload(await storage(), id));
  },
  { auth: false },
);
