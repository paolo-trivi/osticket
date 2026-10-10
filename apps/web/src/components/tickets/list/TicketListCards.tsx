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

/** Lista ticket su mobile: una scheda per ticket con tutte le colonne della coda. */
export default async function TicketListCards({ rows, columns, names, tz, locale }: TicketListProps) {
  const t = await getTranslations("tickets");
  const tq = await getTranslations("queues");
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
        return (
          <li key={r.ticket_id} className="flex gap-3 rounded-2xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-white/3">
            <input type="checkbox" data-mass-tid value={r.ticket_id} aria-label={`#${r.number}`} className="mt-1 size-4 shrink-0 accent-brand-500" />
            <dl className="grid min-w-0 flex-1 grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
              {columns.map((c) => (
                <div key={c.id} className="contents">
                  <dt className="text-theme-xs text-gray-500 uppercase dark:text-gray-400">{tq.has(c.heading) ? tq(c.heading) : c.heading}</dt>
                  <dd className="min-w-0 break-words text-gray-700 dark:text-gray-300">
                    <TicketCell column={c} row={r} tz={tz} locale={locale} assigneeName={assignee} staffName={staff} />
                  </dd>
                </div>
              ))}
            </dl>
          </li>
        );
      })}
    </ul>
  );
}
