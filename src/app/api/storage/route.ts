import { route } from "@/server/http";
import { storageInsights } from "@/server/nodes";
import { systemSnapshot } from "@/server/stats";
import { storage } from "@/server/storage";

/** GET /api/storage — where the space goes, plus the real capacity numbers. */
export const GET = route(async () => {
  const snapshot = systemSnapshot(await storage());
  return Response.json(
    { ...storageInsights(), byType: snapshot.storage.byType, capacity: snapshot.storage.capacity, driver: snapshot.driver, parts: snapshot.storage.parts },
    { headers: { "Cache-Control": "no-store" } },
  );
});
