import { route } from "@/server/http";
import { listVersions } from "@/server/nodes";

/** GET /api/nodes/:id/versions — earlier contents of a file, newest first. */
export const GET = route<RouteContext<"/api/nodes/[id]/versions">>(async (_req, ctx) => {
  const { id } = await ctx.params;
  return Response.json({ versions: listVersions(id) }, { headers: { "Cache-Control": "no-store" } });
});
