import { route } from "@/server/http";
import { collectForArchive } from "@/server/nodes";
import { serveArchive } from "@/server/serve";
import { countDownload, nodeInShare, requireDownloads, resolveShare } from "@/server/shares";

/** ZIP of a shared folder (`?folder=`), or of everything the link holds. */
export const GET = route<RouteContext<"/api/public/[token]/zip">>(
  async (req, ctx) => {
    const { token } = await ctx.params;
    const r = resolveShare(req, token);
    requireDownloads(r);
    const folderId = req.nextUrl.searchParams.get("folder");
    const targets = folderId ? [nodeInShare(r, folderId)] : r.roots;
    const name = folderId ? targets[0].name : r.title;
    countDownload(r, `${name}.zip`);
    return serveArchive(collectForArchive(targets.map((t) => t.id)), name, "public");
  },
  { auth: false },
);
