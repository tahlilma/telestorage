import type { ShareOptions } from "@/lib/types";
import { readJson, route } from "@/server/http";
import { idempotent } from "@/server/idempotency";
import { createRequest, createShare, listShares } from "@/server/shares";

export const GET = route(async (req) => {
  const nodeId = req.nextUrl.searchParams.get("nodeId") ?? undefined;
  return Response.json({ shares: listShares(nodeId) }, { headers: { "Cache-Control": "no-store" } });
});

/**
 * Creates a link for one or more items: { nodeIds, title, note, password,
 * allowDownload, maxDownloads, expiresAt } — or, with { kind: "request",
 * folderId, maxBytes, … }, a file request that collects uploads into a
 * folder. A retry with the same Idempotency-Key returns the same link.
 */
export const POST = route(async (req) =>
  idempotent(req, "share", async () => {
    const { nodeIds, nodeId, kind, folderId, ...options } = await readJson<
      ShareOptions & { nodeIds?: unknown; nodeId?: unknown; expiresInHours?: unknown; kind?: unknown; folderId?: unknown }
    >(req);
    if (kind === "request") return Response.json({ share: createRequest(folderId, options) }, { status: 201 });
    const ids = Array.isArray(nodeIds) ? nodeIds : nodeId ? [nodeId] : [];
    return Response.json({ share: createShare(ids, options) }, { status: 201 });
  }),
);
