import { passwordEnabled, totpEnabled } from "@/server/auth";
import { route } from "@/server/http";

export const GET = route(
  async (_req, _ctx, session) =>
    Response.json(
      {
        authenticated: Boolean(session),
        method: session?.method ?? null,
        providers: { password: passwordEnabled(), totp: totpEnabled() },
      },
      { headers: { "Cache-Control": "no-store" } },
    ),
  { auth: false },
);
