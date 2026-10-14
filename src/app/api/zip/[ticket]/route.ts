import { notFound, route } from "@/server/http";
import { collectForArchive } from "@/server/nodes";
import { serveArchive } from "@/server/serve";
import { redeemTicket } from "@/server/tickets";

export const GET = route<RouteContext<"/api/zip/[ticket]">>(async (_req, ctx) => {
  const ticket = redeemTicket((await ctx.params).ticket);
  if (!ticket) throw notFound("Download link expired — start the download again");
  return serveArchive(collectForArchive(ticket.ids), ticket.name);
});
