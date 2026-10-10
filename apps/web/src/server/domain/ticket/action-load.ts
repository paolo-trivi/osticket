import "server-only";

import type { Agent } from "../staff/staff";
import { ticketThreadId } from "../thread/ids";
import type { WriteContext } from "./context";
import { TicketRecord } from "./record";
import { checkStaffPerm, loadTicket } from "./ticket";

/**
 * Caricamento del ticket per un'azione dell'agente dal menu della vista (ajax.tickets.php): sessione,
 * accesso al ticket e permesso richiesto. Ticket inaccessibile → `not_found`; permesso mancante → `denied`.
 */

export async function loadForAction(
  ctx: WriteContext,
  ticketId: number,
  perm?: string,
): Promise<{ error: string } | { agent: Agent; t: Awaited<ReturnType<typeof loadTicket>> & object; rec: TicketRecord; threadId: number }> {
  const { tx, agent } = ctx;
  if (!agent) return { error: "denied" };
  const t = await loadTicket(ticketId, agent.id, tx);
  if (!t) return { error: "not_found" };
  if (!(await checkStaffPerm(t, agent, perm, tx))) return { error: perm ? "denied" : "not_found" };
  const rec = await TicketRecord.load(tx, ticketId, true);
  if (!rec) return { error: "not_found" };
  return { agent, t, rec, threadId: await ticketThreadId(tx, ticketId) };
}
