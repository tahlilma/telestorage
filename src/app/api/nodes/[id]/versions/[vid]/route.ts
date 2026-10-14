import { route } from "@/server/http";
import { deleteVersion } from "@/server/nodes";
import { invalidateStorageStats } from "@/server/stats";
import { storage } from "@/server/storage";
import { kickGc } from "@/server/storage/maintenance";

/** DELETE /api/nodes/:id/versions/:vid — forget one earlier version (and its storage, unless shared). */
export const DELETE = route<RouteContext<"/api/nodes/[id]/versions/[vid]">>(async (_req, ctx) => {
  const { id, vid } = await ctx.params;
  const purged = deleteVersion(id, vid);
  if (purged.length) void storage().then((rt) => kickGc(rt));
  invalidateStorageStats();
  return Response.json({ ok: true, blobs: purged });
});
