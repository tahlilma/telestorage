import { route } from "@/server/http";
import { requireNode } from "@/server/nodes";
import { storage } from "@/server/storage";
import { loadBlob, prefetchBlob } from "@/server/storage/blobs";

/**
 * POST /api/nodes/:id/warm — the pointer is resting on a file, so it will
 * probably be opened: pull its first blocks from Telegram into the server's
 * cache now (at background priority, nothing is sent back). Opening it then
 * starts from memory instead of a Telegram round trip.
 */
export const POST = route<RouteContext<"/api/nodes/[id]/warm">>(async (_req, ctx) => {
  const { id } = await ctx.params;
  const node = requireNode(id);
  const blob = node.kind === "file" && node.blobId ? loadBlob(node.blobId) : null;
  if (blob && blob.size > 0) prefetchBlob(await storage(), blob, 3);
  return new Response(null, { status: 204 });
});
