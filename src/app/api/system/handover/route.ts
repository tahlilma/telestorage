import { route } from "@/server/http";
import { storage } from "@/server/storage";
import { backupStatus, releaseDrive } from "@/server/storage/backup";

/**
 * Hand-over: back up whatever isn't yet and mark the backup final, so a server
 * started elsewhere (a move to another host) restores it without waiting.
 * The server also does this by itself when it is stopped.
 */
export const POST = route(async () => {
  const result = await releaseDrive(await storage());
  return Response.json({ ...backupStatus(), result });
});
