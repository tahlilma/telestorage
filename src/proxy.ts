import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/server/auth";

/**
 * Redirects signed-out visitors to /login before any page HTML is served.
 * API routes are excluded on purpose: they authenticate themselves, and
 * running proxy on them would buffer upload bodies in memory.
 */
export async function proxy(req: NextRequest) {
  let session;
  try {
    session = await verifySessionToken(req.cookies.get(SESSION_COOKIE)?.value);
  } catch {
    // Index still being restored: serve the page; it shows the progress and
    // every API call checks the session itself once the index is back.
    return NextResponse.next();
  }
  if (session) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  if (req.nextUrl.pathname !== "/") url.searchParams.set("next", req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    "/((?!api/|_next/static|_next/image|favicon.ico|icon|apple-icon|manifest.webmanifest|sw.js|login|s/|r/).*)",
  ],
};
