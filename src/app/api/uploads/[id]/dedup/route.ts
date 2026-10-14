import { readJson, route } from "@/server/http";
import { invalidateStorageStats } from "@/server/stats";
import { storage } from "@/server/storage";
import { kickGc } from "@/server/storage/maintenance";
import { dedupeUpload } from "@/server/storage/uploads";

/**
 * Content-addressed dedup for a running upload: if these exact bytes are
 * already stored, the session is atomically switched to "deduped" and the
 * file appears instantly. Never produces a second file for the same upload.
 */
export const POST = route<RouteContext<"/api/uploads/[id]/dedup">>(async (req, ctx) => {
  const { id } = await ctx.params;
  const body = await readJson<{ sha256?: unknown }>(req);
  const rt = await storage();
  const result = dedupeUpload(rt, id, body);
  if (result.node) {
    invalidateStorageStats();
    void kickGc(rt); // parts already committed for this upload are now redundant
  }
  return Response.json(result);
});
