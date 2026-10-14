import { route } from "@/server/http";
import { listPhotos } from "@/server/nodes";

/** GET /api/photos?cursor=&limit= — the photo and video timeline, a page at a time. */
export const GET = route(async (req) => {
  const cursor = req.nextUrl.searchParams.get("cursor");
  const limit = Number(req.nextUrl.searchParams.get("limit")) || undefined;
  return Response.json(listPhotos(cursor, limit), { headers: { "Cache-Control": "no-store" } });
});
