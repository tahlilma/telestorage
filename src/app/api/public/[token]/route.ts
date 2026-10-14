import type { Crumb, DriveNode } from "@/lib/types";
import { route } from "@/server/http";
import { breadcrumbs, listChildren } from "@/server/nodes";
import { countView, nodeInShare, resolveShare, rootOf } from "@/server/shares";

/** What a visitor may see: names and sizes, never ids outside the shared items. */
const visible = (n: DriveNode) => ({ ...n, parentId: null, blobId: null, previews: null, shareCount: 0 });

/**
 * Public view of a link. `?folder=` browses inside a shared folder; `?visit=1`
 * (sent once per page load) counts a view. A link with several items shows
 * them as a virtual folder whose id is "".
 */
export const GET = route<RouteContext<"/api/public/[token]">>(
  async (req, ctx) => {
    const { token } = await ctx.params;
    const r = resolveShare(req, token);
    const p = req.nextUrl.searchParams;
    if (p.has("visit")) countView(r);
    const folderId = p.get("folder");

    const top: Crumb[] = r.bundle ? [{ id: "", name: r.title }] : [];
    let current: DriveNode | null;
    let path: Crumb[];
    if (folderId) {
      current = nodeInShare(r, folderId);
      const root = rootOf(r, folderId)!;
      const full = breadcrumbs(current.id);
      path = [...top, ...full.slice(full.findIndex((c) => c.id === root.id))];
    } else if (!r.bundle) {
      current = r.roots[0];
      path = [{ id: current.id, name: current.name }];
    } else {
      current = null;
      path = top;
    }
    const items = current ? (current.kind === "folder" ? listChildren(current.id) : []) : r.roots;
    return Response.json(
      {
        share: {
          id: r.row.id,
          title: r.title,
          note: r.row.note,
          expiresAt: r.row.expiresAt,
          allowDownload: r.row.allowDownload === 1,
          hasPassword: r.row.passwordHash !== null,
          downloadsLeft: r.row.maxDownloads === null ? null : Math.max(0, r.row.maxDownloads - r.row.downloads),
          bundle: r.bundle,
          itemCount: r.roots.length,
        },
        current: current ? visible(current) : null,
        path,
        items: items.map(visible),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  },
  { auth: false },
);
