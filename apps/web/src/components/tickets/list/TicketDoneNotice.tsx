import { getTranslations } from "next-intl/server";

import Callout from "@/components/common/Callout";
import type { Agent } from "@/server/domain/staff/staff";
import { ticketDoneSummary } from "@/server/domain/ticket/view";

type TicketDoneKind = "assign" | "transfer" | "status" | "delete";

export const isTicketDoneKind = (v: string | undefined): v is TicketDoneKind => v === "assign" || v === "transfer" || v === "status" || v === "delete";

/** numero di un ticket eliminato preso dall'URL: solo caratteri da numero di ticket, altrimenti nessuno */
const safeNumber = (v: string | undefined) => (v && /^[A-Za-z0-9-]{1,32}$/.test(v) ? v : null);

/**
 * Esito dell'azione con cui la vista ticket è tornata alla lista (?done=<azione>&tid=<id>), come il
 * messaggio di sessione di scp/tickets.php. Il testo nasce dai dati attuali del ticket, non dall'URL; se
 * l'agente non vede più il ticket (es. trasferito a un reparto senza accesso) il messaggio è generico.
 * Dopo l'eliminazione (?done=delete&number=<numero>) il ticket non esiste più: il numero viene dall'URL.
 */
export default async function TicketDoneNotice({ agent, kind, ticketId, number }: { agent: Agent; kind: TicketDoneKind; ticketId: number; number?: string }) {
  const t = await getTranslations("tickets.done");
  if (kind === "delete") {
    const n = safeNumber(number);
    return (
      <Callout tone="success" role="status">
        {n ? t("delete", { number: n }) : t("deleteGeneric")}
      </Callout>
    );
  }
  const s = ticketId ? await ticketDoneSummary(agent, ticketId) : null;
  return (
    <Callout tone="success" role="status">
      {s ? t(kind, s) : t("generic")}
    </Callout>
  );
}
