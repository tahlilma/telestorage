import { badRequest, readJson, route } from "@/server/http";
import { findConflicts } from "@/server/nodes";

/** Which of these upload paths already exist as files, asked before uploading so the user can choose. */
export const POST = route(async (req) => {
  const { parentId, paths } = await readJson<{ parentId?: string; paths?: unknown }>(req);
  if (!Array.isArray(paths)) throw badRequest("paths must be an array");
  return Response.json({ conflicts: findConflicts(parentId || "root", paths as string[]) }, { headers: { "Cache-Control": "no-store" } });
});
