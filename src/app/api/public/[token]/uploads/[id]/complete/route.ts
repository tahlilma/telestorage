import { readJson, route } from "@/server/http";
import { resolveShare } from "@/server/shares";
import { invalidateStorageStats } from "@/server/stats";
import { storage } from "@/server/storage";
import { completeUpload, requireRequestUpload } from "@/server/storage/uploads";

/**
 * POST — finishes a visitor's upload (SHA-256 + part roots, like the owner's).
 * 409 + { missing } means some ranges must be sent again first.
 */
export const POST = route<RouteContext<"/api/public/[token]/uploads/[id]/complete">>(
  async (req, ctx) => {
    const { token, id } = await ctx.params;
    const r = resolveShare(req, token, { kind: "request" });
    requireRequestUpload(id, r.row.id);
    const body = await readJson<{ sha256?: unknown; parts?: unknown }>(req);
    const result = await completeUpload(await storage(), id, { sha256: body.sha256, parts: body.parts });
    if ("missing" in result) return Response.json(result, { status: 409 });
    invalidateStorageStats();
    // The visitor only learns that it arrived.
    return Response.json({ done: true });
  },
  { auth: false },
);
