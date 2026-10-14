import { route } from "@/server/http";
import { serveFile } from "@/server/serve";
import { countDownload, nodeInShare, requireDownloads, resolveShare } from "@/server/shares";

type Ctx = RouteContext<"/api/public/[token]/file/[nodeId]/[...name]">;

const handler = route<Ctx>(
  async (req, ctx) => {
    const { token, nodeId } = await ctx.params;
    const r = resolveShare(req, token);
    const node = nodeInShare(r, nodeId);
    const download = req.nextUrl.searchParams.has("dl");
    if (download) requireDownloads(r);
    return serveFile(req, node, {
      download,
      cache: "share",
      onServe: download && req.method === "GET" ? () => countDownload(r, node.name) : undefined,
    });
  },
  { auth: false },
);

export const GET = handler;
export const HEAD = handler;
