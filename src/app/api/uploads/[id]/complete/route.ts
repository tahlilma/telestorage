import { readJson, route } from "@/server/http";
import { invalidateStorageStats } from "@/server/stats";
import { storage } from "@/server/storage";
import { completeUpload } from "@/server/storage/uploads";

/**
 * Finalises an upload. Body: { sha256, parts }: the whole-file SHA-256 and one
 * hash-tree root per part (see protocol.ts); older clients send `windows`.
 * 409 + { missing, reason } means some ranges must be (re)sent first; repeating
 * the call after success returns the same file.
 */
export const POST = route<RouteContext<"/api/uploads/[id]/complete">>(async (req, ctx) => {
  const { id } = await ctx.params;
  const body = await readJson<{ sha256?: unknown; parts?: unknown; windows?: unknown }>(req);
  const result = await completeUpload(await storage(), id, body);
  if ("missing" in result) return Response.json(result, { status: 409 });
  invalidateStorageStats();
  return Response.json(result);
});
