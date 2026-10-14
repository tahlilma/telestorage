import { readJson, route } from "@/server/http";
import { idempotent } from "@/server/idempotency";
import { invalidateStorageStats } from "@/server/stats";
import { storage } from "@/server/storage";
import { createUpload } from "@/server/storage/uploads";

/** Starts an upload session. Retries with the same Idempotency-Key return the same session. */
export const POST = route(async (req) =>
  idempotent(req, "upload-init", async () => {
    const rt = await storage();
    const body = await readJson<{ name: unknown; size: unknown; mime: unknown; parentId: unknown }>(req);
    const result = createUpload(rt, body);
    if ("node" in result) invalidateStorageStats();
    return Response.json(result, { status: 201 });
  }),
);
