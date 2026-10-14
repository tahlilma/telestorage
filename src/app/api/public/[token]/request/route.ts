import { route } from "@/server/http";
import { requestInfo, resolveShare } from "@/server/shares";

/**
 * GET /api/public/:token/request — what a file request asks for. Reveals the
 * title and note the owner wrote, never the folder's name or contents.
 */
export const GET = route<RouteContext<"/api/public/[token]/request">>(
  async (req, ctx) => {
    const { token } = await ctx.params;
    const r = resolveShare(req, token, { kind: "request" });
    return Response.json(requestInfo(r), { headers: { "Cache-Control": "no-store" } });
  },
  { auth: false },
);
