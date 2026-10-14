import type { ShareOptions } from "@/lib/types";
import { readJson, route } from "@/server/http";
import { deleteShare, updateShare } from "@/server/shares";

type Ctx = RouteContext<"/api/shares/[id]">;

/** Changes a link's options (title, note, password, downloads, limit, expiry). */
export const PATCH = route<Ctx>(async (req, ctx) => {
  const body = await readJson<ShareOptions>(req);
  return Response.json({ share: updateShare((await ctx.params).id, body) });
});

/** Turns a link off for everyone, immediately. */
export const DELETE = route<Ctx>(async (_req, ctx) => {
  deleteShare((await ctx.params).id);
  return Response.json({ ok: true });
});
