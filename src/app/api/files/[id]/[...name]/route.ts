import { route } from "@/server/http";
import { requireNode, versionContent } from "@/server/nodes";
import { serveFile } from "@/server/serve";

type Ctx = RouteContext<"/api/files/[id]/[...name]">;

/**
 * GET /api/files/:id/:filename — the trailing filename makes URLs self-describing
 * for media players and "Save as". `?dl=1` forces a download; `?v=<version id>`
 * serves an earlier version of the file.
 */
const handler = route<Ctx>(async (req, ctx) => {
  const { id } = await ctx.params;
  const node = requireNode(id);
  const version = req.nextUrl.searchParams.get("v");
  const served = version ? { ...node, ...versionContent(id, version) } : node;
  return serveFile(req, served, { download: req.nextUrl.searchParams.has("dl"), cache: "private" });
});

export const GET = handler;
export const HEAD = handler;
