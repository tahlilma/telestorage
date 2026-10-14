import { notFound, route } from "@/server/http";
import { thumbResponse } from "@/server/serve";
import { nodeInShare, resolveShare } from "@/server/shares";

export const GET = route<RouteContext<"/api/public/[token]/thumb/[nodeId]">>(
  async (req, ctx) => {
    const { token, nodeId } = await ctx.params;
    const node = nodeInShare(resolveShare(req, token), nodeId);
    if (!node.blobId) throw notFound();
    return thumbResponse(node.blobId, req);
  },
  { auth: false },
);
