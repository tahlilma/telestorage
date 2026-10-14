import { sql } from "@/server/db";
import { readJson, route } from "@/server/http";
import { breadcrumbs, rename, requireNode, setStarred } from "@/server/nodes";
import { loadBlob } from "@/server/storage/blobs";

export const GET = route<RouteContext<"/api/nodes/[id]">>(async (_req, ctx) => {
  const { id } = await ctx.params;
  const node = requireNode(id);
  const blob = node.blobId ? loadBlob(node.blobId) : null;
  const corruptAt = blob ? (sql("SELECT corrupt_at FROM blobs WHERE id = ?").pluck().get(blob.id) as number | null) : null;
  return Response.json(
    {
      node,
      path: breadcrumbs(id),
      storage: blob
        ? {
            parts: blob.partCount,
            partSize: blob.partSize,
            driver: blob.driver,
            encrypted: Boolean(blob.encIv),
            sha256: blob.sha256,
            integrity: corruptAt ? "corrupt" : blob.verifiedAt ? "verified" : blob.sha256 ? "pending" : "legacy",
            verifiedAt: blob.verifiedAt,
            pieceChecksums: blob.parts.every((p) => p.pieceHashes),
          }
        : null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
});

export const PATCH = route<RouteContext<"/api/nodes/[id]">>(async (req, ctx) => {
  const { id } = await ctx.params;
  const body = await readJson<{ name?: string; starred?: boolean }>(req);
  if (typeof body.starred === "boolean") setStarred([id], body.starred);
  const node = body.name !== undefined ? rename(id, body.name) : requireNode(id);
  return Response.json({ node });
});
