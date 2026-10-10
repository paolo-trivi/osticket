import { getTranslations } from "next-intl/server";

import TicketCell from "@/components/tickets/TicketCell";
import type { QueueColumnDef } from "@/server/domain/queue/columns";
import type { TicketRow } from "@/server/domain/ticket/rows";

export interface TicketListProps {
  rows: TicketRow[];
  columns: QueueColumnDef[];
  /** nomi degli agenti assegnatari per staff_id */
  names: Map<number, string>;
  tz: string;
  locale: string;
}

/**
 * Lista ticket su mobile: una scheda per ticket con tutte le colonne della coda. Numero e oggetto (se la
 * coda li mostra) stanno in testa su righe intere, l'oggetto senza troncamento; le altre colonne sono una
 * griglia a due colonne con l'etichetta sopra il valore, così la scheda resta leggibile a 390px.
 */
export default async function TicketListCards({ rows, columns, names, tz, locale }: TicketListProps) {
  const t = await getTranslations("tickets");
  const tq = await getTranslations("queues");
  const numberCol = columns.find((c) => c.primary === "number");
  const subjectCol = columns.find((c) => c.primary === "cdata__subject");
  // sulla scheda l'oggetto va a capo invece di essere troncato
  const subjectFull = subjectCol ? { ...subjectCol, truncate: null } : undefined;
  const rest = columns.filter((c) => c !== numberCol && c !== subjectCol);
  const label = (c: QueueColumnDef) => (tq.has(c.heading) ? tq(c.heading) : c.heading);
  return (
    <ul className="space-y-3 md:hidden">
      {rows.length === 0 && (
        <li className="rounded-2xl border border-gray-200 bg-white px-4 py-8 text-center text-sm text-gray-500 dark:border-gray-800 dark:bg-white/3 dark:text-gray-400">
          {t("empty")}
        </li>
      )}
      {rows.map((r) => {
        const staff = names.get(r.staff_id) ?? "";
        const assignee = staff || r.team_name || "";
        const cell = (c: QueueColumnDef) => <TicketCell column={c} row={r} tz={tz} locale={locale} assigneeName={assignee} staffName={staff} />;
        return (
          <li key={r.ticket_id} className="flex gap-3 rounded-2xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-white/3">
            <input type="checkbox" data-mass-tid value={r.ticket_id} aria-label={`#${r.number}`} className="mt-1 size-4 shrink-0 accent-brand-500" />
            <div className="min-w-0 flex-1 space-y-2">
              {numberCol && <div className="text-sm font-medium text-gray-700 dark:text-gray-300">{cell(numberCol)}</div>}
              {subjectFull && <div className="text-sm font-semibold break-words text-gray-800 dark:text-white/90">{cell(subjectFull)}</div>}
              {rest.length > 0 && (
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                  {rest.map((c) => (
                    <div key={c.id} className="min-w-0">
                      <dt className="truncate text-theme-xs text-gray-500 dark:text-gray-400">{label(c)}</dt>
                      <dd className="min-w-0 break-words text-gray-700 dark:text-gray-300">{cell(c)}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
