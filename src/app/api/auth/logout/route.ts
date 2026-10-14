import { clearSessionCookie, revokeAllSessions } from "@/server/auth";
import { route } from "@/server/http";

export const POST = route(
  async (req, _ctx, session) => {
    // `?all=1` signs out every device by bumping the session version.
    if (session && req.nextUrl.searchParams.get("all") === "1") revokeAllSessions();
    return Response.json({ ok: true }, { headers: { "Set-Cookie": clearSessionCookie() } });
  },
  { auth: false },
);
