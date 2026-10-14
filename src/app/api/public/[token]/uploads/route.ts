import { HttpError, readJson, route } from "@/server/http";
import { rateLimitRequestUpload, resolveShare } from "@/server/shares";
import { storage } from "@/server/storage";
import { createUpload } from "@/server/storage/uploads";

/**
 * POST /api/public/:token/uploads — a visitor starts an upload through a file
 * request. It always lands in the request's folder, never replaces anything
 * (a taken name gets a number), and can't use content dedup (which would
 * reveal what the owner already has).
 */
export const POST = route<RouteContext<"/api/public/[token]/uploads">>(
  async (req, ctx) => {
    const { token } = await ctx.params;
    const r = resolveShare(req, token, { kind: "request" });
    const body = await readJson<{ name?: unknown; size?: unknown; mime?: unknown; from?: unknown; takenAt?: unknown }>(req);
    const size = Number(body.size);
    if (r.row.maxBytes !== null && Number.isFinite(size) && size > r.row.maxBytes) {
      throw new HttpError(413, `Files can be at most ${Math.floor(r.row.maxBytes / 1048576).toLocaleString()} MB here`);
    }
    rateLimitRequestUpload(req, r);
    const from = typeof body.from === "string" ? body.from.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80) || null : null;
    const result = createUpload(
      await storage(),
      { name: body.name, size: body.size, mime: body.mime, parentId: r.roots[0].id, onConflict: "keep", takenAt: body.takenAt },
      { via: r.row.id, from },
    );
    // Visitors learn that it worked, nothing about what's in the folder.
    if ("node" in result) return Response.json({ done: true }, { status: 201 });
    return Response.json(result, { status: 201 });
  },
  { auth: false },
);
