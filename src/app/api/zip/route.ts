import { badRequest, readJson, route } from "@/server/http";
import { isId } from "@/server/ids";
import { issueTicket } from "@/server/tickets";

export const POST = route(async (req) => {
  const { ids, name } = await readJson<{ ids?: string[]; name?: string }>(req);
  if (!Array.isArray(ids) || !ids.length || !ids.every(isId)) throw badRequest("ids are required");
  const ticket = issueTicket(ids, (name || "telestorage").slice(0, 120));
  return Response.json({ url: `/api/zip/${ticket}` });
});
