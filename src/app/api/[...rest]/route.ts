/**
 * Any /api path no route handles. Without this, the drive's catch-all page
 * would answer with the app's HTML and a 200 — confusing for API clients and
 * a false "success" for typos. Every method gets a plain JSON 404.
 */
const notFound = () => Response.json({ error: "No such API endpoint" }, { status: 404, headers: { "Cache-Control": "no-store" } });

export const GET = notFound;
export const HEAD = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
export const OPTIONS = notFound;
