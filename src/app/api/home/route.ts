import type { HomeData } from "@/lib/types";
import { listActivity } from "@/server/activity";
import { route } from "@/server/http";
import { driveStats, listRecent, listRecentFolders, listSharedFolders, listStarredFolders } from "@/server/nodes";

/** Everything the home screen needs, in one round trip. */
export const GET = route(async () => {
  const body: HomeData = {
    stats: driveStats(),
    recentFiles: listRecent(12),
    folders: { recent: listRecentFolders(8), starred: listStarredFolders(8), shared: listSharedFolders(8) },
    activity: listActivity(12),
  };
  return Response.json(body, { headers: { "Cache-Control": "no-store" } });
});
