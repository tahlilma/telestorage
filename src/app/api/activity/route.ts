import { listActivity } from "@/server/activity";
import { route } from "@/server/http";

export const GET = route(async (req) => {
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? 50);
  return Response.json({ items: listActivity(Number.isFinite(limit) ? limit : 50) }, { headers: { "Cache-Control": "no-store" } });
});
