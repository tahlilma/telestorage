import { readJson, route } from "@/server/http";
import { unlockShare } from "@/server/shares";

/** Exchanges a link's password for an unlock cookie (rate-limited per visitor). */
export const POST = route<RouteContext<"/api/public/[token]/unlock">>(
  async (req, ctx) => {
    const { token } = await ctx.params;
    const { password } = await readJson<{ password?: unknown }>(req);
    const cookie = unlockShare(req, token, password);
    return Response.json({ ok: true }, { headers: { "Set-Cookie": cookie } });
  },
  { auth: false },
);
