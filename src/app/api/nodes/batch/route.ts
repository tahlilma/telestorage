import type { BatchOp } from "@/lib/types";
import { sql } from "@/server/db";
import { badRequest, readJson, route } from "@/server/http";
import { idempotent } from "@/server/idempotency";
import { isId } from "@/server/ids";
import { copy, deleteForever, emptyTrash, move, restore, setColor, setStarred, trash } from "@/server/nodes";
import { invalidateStorageStats } from "@/server/stats";
import { storage } from "@/server/storage";
import { kickGc } from "@/server/storage/maintenance";

/** Parts queued for removal from storage for the given blobs. */
const queuedParts = (blobIds: string[]) =>
  blobIds.length ? (sql("SELECT COUNT(*) FROM gc_queue WHERE blob_id IN (SELECT value FROM json_each(?))").pluck().get(JSON.stringify(blobIds)) as number) : 0;

export const POST = route(async (req) =>
  idempotent(req, "batch", async () => {
    const op = await readJson<BatchOp>(req);
    if (op.op !== "emptyTrash") {
      if (!Array.isArray(op.ids) || !op.ids.length || op.ids.length > 10_000 || !op.ids.every(isId)) {
        throw badRequest("ids must be a non-empty array of node ids");
      }
    }
    let result: Record<string, unknown> = { ok: true };
    switch (op.op) {
      case "move":
        if (!isId(op.targetId)) throw badRequest("targetId is required");
        result = { ok: true, ...move(op.ids, op.targetId) };
        break;
      case "copy":
        if (!isId(op.targetId)) throw badRequest("targetId is required");
        result = { nodes: copy(op.ids, op.targetId) };
        break;
      case "trash":
        trash(op.ids);
        break;
      case "restore":
        restore(op.ids);
        break;
      case "delete":
      case "emptyTrash": {
        const purged = op.op === "delete" ? deleteForever(op.ids) : emptyTrash();
        const parts = queuedParts(purged);
        // Deleted content leaves the Telegram channel now, not on the next GC tick.
        if (parts) void storage().then((rt) => kickGc(rt));
        // The client uses the blob ids to confirm removal from Telegram when the "gc" live event arrives.
        result = { purgedBlobs: purged.length, blobs: purged, queuedParts: parts };
        break;
      }
      case "star":
        setStarred(op.ids, Boolean(op.starred));
        break;
      case "color":
        setColor(op.ids, op.color ?? null);
        break;
      default:
        throw badRequest("Unknown operation");
    }
    invalidateStorageStats();
    return Response.json(result);
  }),
);
