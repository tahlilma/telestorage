import { route } from "@/server/http";
import { metrics } from "@/server/metrics";
import { systemSnapshot } from "@/server/stats";
import { storage } from "@/server/storage";

export const GET = route(async () => {
  const rt = await storage();
  return Response.json(
    { snapshot: systemSnapshot(rt), series: metrics.seriesSnapshot() },
    { headers: { "Cache-Control": "no-store" } },
  );
});
