import { lastFsck, runFsck } from "@/server/fsck";
import { route } from "@/server/http";
import { invalidateStorageStats } from "@/server/stats";
import { storage } from "@/server/storage";
import { kickGc } from "@/server/storage/maintenance";

export const GET = route(async () => Response.json({ report: lastFsck() }, { headers: { "Cache-Control": "no-store" } }));

/** Runs the metadata consistency checker now (with safe repairs). */
export const POST = route(async () => {
  const report = runFsck({ repair: true });
  if (report.needsGc) void storage().then((rt) => kickGc(rt));
  invalidateStorageStats();
  return Response.json({ report });
});
