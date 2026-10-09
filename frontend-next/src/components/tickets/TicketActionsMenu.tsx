import type { Agent } from "@/server/domain/staff/staff";
import type { TicketDetail } from "@/server/domain/ticket/ticket";

/**
 * Slot della vista ticket per assegnazione, presa in carico, rilascio, trasferimento, referral,
 * cambio stato, segna risposto/non risposto (area "actions").
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- slot da implementare
export default async function TicketActionsMenu(_props: { ticket: TicketDetail; agent: Agent; locale: string }) {
  return null;
}
