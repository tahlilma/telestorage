/**
 * The share-sheet target. The service worker normally answers the POST itself
 * (it parks the files and opens the app); this only runs if it couldn't — e.g.
 * right after installing, before the worker took control. Then the files can't
 * be kept, so the app opens and says so.
 */
export function POST(req: Request) {
  return Response.redirect(new URL("/?received=unsupported", req.url), 303);
}

export function GET(req: Request) {
  return Response.redirect(new URL("/", req.url), 303);
}
