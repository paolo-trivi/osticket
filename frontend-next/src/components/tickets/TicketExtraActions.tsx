import type { Agent } from "@/server/domain/staff/staff";
import type { TicketDetail } from "@/server/domain/ticket/ticket";

/**
 * Slot della vista ticket per modifica campi, collaboratori, merge/link, eliminazione, stampa/export
 * (area "ticketedit").
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- slot da implementare
export default async function TicketExtraActions(_props: { ticket: TicketDetail; agent: Agent; locale: string }) {
  return null;
}
