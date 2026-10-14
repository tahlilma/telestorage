import "server-only";
import { newId } from "./ids";

/**
 * Short-lived download tickets. The browser POSTs a (possibly huge) selection
 * once and then navigates to a plain GET URL, which lets the native download
 * manager handle progress, pause and resume.
 */
interface Ticket {
  ids: string[];
  name: string;
  expires: number;
}

const g = globalThis as unknown as { __tsTickets?: Map<string, Ticket> };
const tickets = (g.__tsTickets ??= new Map());

export function issueTicket(ids: string[], name: string): string {
  const now = Date.now();
  for (const [k, t] of tickets) if (t.expires < now) tickets.delete(k);
  const id = newId(24);
  tickets.set(id, { ids, name, expires: now + 10 * 60_000 });
  return id;
}

export function redeemTicket(id: string): Ticket | null {
  const t = tickets.get(id);
  if (!t || t.expires < Date.now()) return null;
  return t;
}
