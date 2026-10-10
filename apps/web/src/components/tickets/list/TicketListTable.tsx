import { ArrowDown, ArrowUp } from "lucide-react";
import { getTranslations } from "next-intl/server";

import MassSelectAll from "@/components/tickets/mass/MassSelectAll";
import TicketCell from "@/components/tickets/TicketCell";
import { Link } from "@/i18n/navigation";

import type { TicketListProps } from "./TicketListCards";

interface TicketListTableProps extends TicketListProps {
  /** colonna di ordinamento corrente (?sort) e direzione (1 = crescente) */
  sort?: string;
  dir: number;
  /** link alla stessa lista con ordinamento diverso */
  sortHref: (column: number, dir: number) => string;
}

/** Lista ticket da md in su: tabella con le colonne della coda, intestazioni ordinabili e selezione di massa. */
export default async function TicketListTable({ rows, columns, names, tz, locale, sort, dir, sortHref }: TicketListTableProps) {
  const t = await getTranslations("tickets");
  const tq = await getTranslations("queues");
  return (
    <div className="hidden overflow-x-auto rounded-2xl border border-gray-200 bg-white md:block dark:border-gray-800 dark:bg-white/3">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="border-b border-gray-100 dark:border-gray-800">
            <th className="w-10 px-4 py-3">
              <MassSelectAll />
            </th>
            {columns.map((c) => {
              const sorted = sort === String(c.id);
              const nextDir = sorted && dir === 0 ? 1 : 0;
              return (
                <th
                  key={c.id}
                  style={{ width: c.width }}
                  className="px-4 py-3 text-start text-theme-xs font-medium whitespace-nowrap text-gray-500 uppercase dark:text-gray-400"
                >
                  {c.sortable ? (
                    <Link href={sortHref(c.id, nextDir)} className="inline-flex items-center gap-1 hover:text-gray-800 dark:hover:text-white">
                      {tq.has(c.heading) ? tq(c.heading) : c.heading}
                      {sorted ? dir === 1 ? <ArrowUp className="size-3.5" /> : <ArrowDown className="size-3.5" /> : null}
                    </Link>
                  ) : tq.has(c.heading) ? (
                    tq(c.heading)
                  ) : (
                    c.heading
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length + 1} className="px-4 py-10 text-center text-gray-500 dark:text-gray-400">
                {t("empty")}
              </td>
            </tr>
          )}
          {rows.map((r) => {
            const staff = names.get(r.staff_id) ?? "";
            const assignee = staff || r.team_name || "";
            return (
              <tr key={r.ticket_id} className="hover:bg-gray-50 dark:hover:bg-white/2">
                <td className="px-4 py-3">
                  <input type="checkbox" data-mass-tid value={r.ticket_id} aria-label={`#${r.number}`} className="size-4 accent-brand-500" />
                </td>
                {columns.map((c) => (
                  <td key={c.id} className="max-w-xs px-4 py-3 text-gray-700 dark:text-gray-300">
                    <TicketCell column={c} row={r} tz={tz} locale={locale} assigneeName={assignee} staffName={staff} />
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
