import { badRequest, route } from "@/server/http";
import { storage } from "@/server/storage";
import { kickGc } from "@/server/storage/maintenance";
import { abortUpload, parseDigest, partsInFlight, uploadStatus, writeChunk } from "@/server/storage/uploads";

type Ctx = RouteContext<"/api/uploads/[id]">;

/**
 * Session state and the byte ranges still missing: lets a client resume after
 * a crash, a network switch or a reload. `?coarse=1` returns one range per run
 * of missing bytes instead of 8 MiB slices (small answers for huge files).
 */
export const GET = route<Ctx>(async (req, ctx) => {
  const { id } = await ctx.params;
  const coarse = req.nextUrl.searchParams.get("coarse") === "1";
  const status = { ...uploadStatus(id, { coarse }), partsInFlight: partsInFlight(await storage()) };
  return Response.json(status, { headers: { "Cache-Control": "no-store" } });
});

/**
 * Receives one chunk: PUT /api/uploads/:id?part=0&offset=8388608 with raw bytes as the body
 * and `Content-Digest: sha-256=:<base64>:` (RFC 9530). Mismatching chunks are rejected with 422.
 */
export const PUT = route<Ctx>(async (req, ctx) => {
  const { id } = await ctx.params;
  const part = Number(req.nextUrl.searchParams.get("part"));
  const offset = Number(req.nextUrl.searchParams.get("offset"));
  if (!Number.isInteger(part) || !Number.isInteger(offset)) throw badRequest("part and offset are required");
  const lengthHeader = req.headers.get("content-length");
  const contentLength = lengthHeader !== null && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : null;
  const digest = parseDigest(req.headers.get("content-digest"), req.headers.get("x-chunk-sha256"));
  const rt = await storage();
  return Response.json(await writeChunk(rt, id, part, offset, req.body, { digest, contentLength }));
});

export const DELETE = route<Ctx>(async (_req, ctx) => {
  const { id } = await ctx.params;
  const rt = await storage();
  const result = await abortUpload(rt, id);
  void kickGc(rt); // committed parts of a cancelled upload leave the channel right away
  return Response.json(result);
});
