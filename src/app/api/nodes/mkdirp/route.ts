import { badRequest, readJson, route } from "@/server/http";
import { idempotent } from "@/server/idempotency";
import { mkdirp } from "@/server/nodes";

export const POST = route(async (req) =>
  idempotent(req, "mkdirp", async () => {
    const { parentId, paths } = await readJson<{ parentId?: string; paths?: string[] }>(req);
    if (!Array.isArray(paths) || paths.length > 50_000 || !paths.every((p) => typeof p === "string")) {
      throw badRequest("paths must be an array of strings");
    }
    return Response.json({ folders: mkdirp(parentId || "root", paths) });
  }),
);
