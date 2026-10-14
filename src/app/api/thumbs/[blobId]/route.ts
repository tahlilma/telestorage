import { sql } from "@/server/db";
import { emitNodes } from "@/server/events";
import { badRequest, route } from "@/server/http";
import { requireNode } from "@/server/nodes";
import { thumbResponse } from "@/server/serve";

type Ctx = RouteContext<"/api/thumbs/[blobId]">;
const MAX_THUMB_BYTES = 256 * 1024;

export const GET = route<Ctx>(async (req, ctx) => thumbResponse((await ctx.params).blobId, req));

/** PUT /api/thumbs/:nodeId — client-generated WebP thumbnail, stored per blob (deduped content shares it). */
export const PUT = route<Ctx>(async (req, ctx) => {
  const { blobId: nodeId } = await ctx.params;
  const node = requireNode(nodeId);
  if (!node.blobId) throw badRequest("Folders have no thumbnail");
  const mime = req.headers.get("content-type") ?? "";
  if (!/^image\/(webp|jpeg|png|avif)$/.test(mime)) throw badRequest("Unsupported thumbnail type");
  const data = Buffer.from(await req.arrayBuffer());
  if (!data.length || data.length > MAX_THUMB_BYTES) throw badRequest("Thumbnail too large");
  const w = Number(req.nextUrl.searchParams.get("w")) || null;
  const h = Number(req.nextUrl.searchParams.get("h")) || null;
  sql(
    // A replaced thumbnail leaves its pack: it goes to Telegram in the next one.
    "INSERT INTO thumbs (blob_id, mime, data, width, height) VALUES (?, ?, ?, ?, ?) ON CONFLICT(blob_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, width = excluded.width, height = excluded.height, pack = NULL",
  ).run(node.blobId, mime, data, w, h);
  // Every file sharing this content (copies, dedup links) just gained a thumbnail.
  const holders = sql("SELECT id, parent_id AS parentId FROM nodes WHERE blob_id = ?").all(node.blobId) as { id: string; parentId: string | null }[];
  emitNodes("thumb", { parents: holders.map((h) => h.parentId), ids: holders.map((h) => h.id) });
  return Response.json({ ok: true });
});
