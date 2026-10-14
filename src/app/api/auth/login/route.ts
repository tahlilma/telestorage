import {
  checkPassword,
  checkTotp,
  clearLoginFailures,
  clientIp,
  createSessionToken,
  loginBlockedFor,
  passwordEnabled,
  recordLoginFailure,
  sessionCookie,
  totpEnabled,
} from "@/server/auth";
import { readJson, route } from "@/server/http";
import { log } from "@/server/metrics";

export const POST = route(
  async (req) => {
    const ip = clientIp(req);
    const blocked = loginBlockedFor(ip);
    if (blocked) {
      return Response.json({ error: `Too many attempts. Try again in ${Math.ceil(blocked / 60)} min.` }, { status: 429 });
    }
    if (!passwordEnabled()) return Response.json({ error: "Password login is disabled" }, { status: 400 });

    const body = await readJson<{ password?: string; totp?: string }>(req);
    const passwordOk = checkPassword(String(body.password ?? ""));
    if (passwordOk && totpEnabled() && !body.totp) {
      return Response.json({ totpRequired: true }, { status: 401 });
    }
    if (!passwordOk || !checkTotp(String(body.totp ?? ""))) {
      recordLoginFailure(ip);
      log.warn("auth", `failed login from ${ip}`);
      // Constant-ish delay blunts online guessing further.
      await new Promise((r) => setTimeout(r, 400));
      return Response.json({ error: passwordOk ? "Invalid authentication code" : "Wrong password" }, { status: 401 });
    }

    clearLoginFailures(ip);
    log.info("auth", `password login from ${ip}`);
    const token = await createSessionToken();
    return Response.json({ ok: true }, { headers: { "Set-Cookie": sessionCookie(req, token) } });
  },
  { auth: false },
);
