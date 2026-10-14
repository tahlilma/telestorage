import { route } from "@/server/http";
import { storage } from "@/server/storage";
import { backupStatus, runBackup } from "@/server/storage/backup";

/** "Back up now": stores the index in the channel even if nothing changed. */
export const POST = route(async () => {
  const result = await runBackup(await storage(), { force: true });
  return Response.json({ ...backupStatus(), result });
});
