import { badRequest, readJson, route } from "@/server/http";
import { idempotent } from "@/server/idempotency";
import { metrics } from "@/server/metrics";
import { createFolder, folderListing, listRecent, listStarred, listTrash, search } from "@/server/nodes";
import { invalidateStorageStats } from "@/server/stats";

const noStore = { headers: { "Cache-Control": "no-store" } };

export const GET = route(async (req) => {
  const t0 = performance.now();
  const p = req.nextUrl.searchParams;
  const view = p.get("view");
  let body: unknown;
  if (!view) {
    body = folderListing(p.get("parent") || "root", p.get("folders") === "1");
  } else if (view === "recent") {
    body = { items: listRecent() };
  } else if (view === "starred") {
    body = { items: listStarred() };
  } else if (view === "trash") {
    body = { items: listTrash() };
  } else if (view === "search") {
    body = { items: search(p.get("q") ?? "") };
  } else {
    throw badRequest("Unknown view");
  }
  metrics.latency.apiList.record(performance.now() - t0);
  return Response.json(body, noStore);
});

export const POST = route(async (req) =>
  idempotent(req, "create-folder", async () => {
    const { parentId, name } = await readJson<{ parentId?: string; name?: string }>(req);
    const node = createFolder(parentId || "root", name);
    invalidateStorageStats();
    return Response.json({ node }, { status: 201 });
  }),
);
