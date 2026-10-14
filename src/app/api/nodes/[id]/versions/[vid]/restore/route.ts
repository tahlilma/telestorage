import { route } from "@/server/http";
import { idempotent } from "@/server/idempotency";
import { restoreVersion } from "@/server/nodes";
import { invalidateStorageStats } from "@/server/stats";
import { storage } from "@/server/storage";
import { kickGc } from "@/server/storage/maintenance";

/**
 * POST /api/nodes/:id/versions/:vid/restore — make an earlier version current
 * again. What it replaces becomes a version itself, so nothing is lost.
 */
export const POST = route<RouteContext<"/api/nodes/[id]/versions/[vid]/restore">>(async (req, ctx) => {
  const { id, vid } = await ctx.params;
  return idempotent(req, "restore-version", async () => {
    const { node, purged } = restoreVersion(id, vid);
    if (purged.length) void storage().then((rt) => kickGc(rt));
    invalidateStorageStats();
    return Response.json({ node });
  });
});
