import { getTranslations } from "next-intl/server";

import TicketActionsMenu from "@/components/tickets/TicketActionsMenu";
import TicketExtraActions from "@/components/tickets/TicketExtraActions";
import Badge from "@/components/ui/badge/Badge";
import { Link } from "@/i18n/navigation";
import type { Agent } from "@/server/domain/staff/staff";
import type { TicketDetail } from "@/server/domain/ticket/ticket";
import { stripTags } from "@/server/format/html";

interface TicketHeaderProps {
  ticket: TicketDetail;
  agent: Agent;
  locale: string;
  taskCount: number;
  /** URL dell'osTicket PHP (rimando al pannello classico), se configurato */
  legacyUrl?: string;
}

/** Intestazione della vista ticket: ritorno alla lista, oggetto, stato e badge, barre delle azioni. */
export default async function TicketHeader({ ticket, agent, locale, taskCount, legacyUrl }: TicketHeaderProps) {
  const t = await getTranslations("ticket");
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <Link href="/agent/tickets" className="text-theme-sm text-gray-500 hover:text-brand-500 dark:text-gray-400">
          ← {t("backToList")}
        </Link>
        <h1 className="mt-1 text-title-sm font-semibold text-gray-800 dark:text-white/90">
          #{ticket.number} · {stripTags(ticket.subject)}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Badge color={ticket.status_state === "open" ? "success" : "light"}>{ticket.status_name}</Badge>
          {ticket.priority && (
            <span className="inline-flex items-center gap-1.5 text-theme-sm text-gray-600 dark:text-gray-400">
              <span className="size-2.5 rounded-full" style={{ backgroundColor: ticket.priority_color ?? "#ccc" }} />
              {ticket.priority}
            </span>
          )}
          {ticket.isoverdue && <Badge color="error">{t("overdue")}</Badge>}
          {ticket.isanswered && <Badge color="info">{t("answered")}</Badge>}
          {ticket.locked_by_other && <Badge color="warning">🔒 {t("locked")}</Badge>}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <TicketActionsMenu ticket={ticket} agent={agent} locale={locale} />
        <TicketExtraActions ticket={ticket} agent={agent} locale={locale} />
        <Link
          href={`/agent/tasks?ticket=${ticket.ticket_id}`}
          className="rounded-lg border border-gray-200 px-3 py-2 text-theme-sm text-gray-600 hover:bg-gray-50 dark:border-gray-800 dark:text-gray-400 dark:hover:bg-white/5"
        >
          {t("tasks", { count: taskCount })}
        </Link>
      </div>
      {legacyUrl && (
        <a
          href={`${legacyUrl}/scp/tickets.php?id=${ticket.ticket_id}`}
          className="rounded-lg border border-gray-200 px-3 py-2 text-theme-sm text-gray-600 hover:bg-gray-50 dark:border-gray-800 dark:text-gray-400 dark:hover:bg-white/5"
        >
          {t("openLegacy")}
        </a>
      )}
    </div>
  );
}
