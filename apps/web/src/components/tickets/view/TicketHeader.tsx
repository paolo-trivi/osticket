import { ArrowLeft, Lock } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { WriteGate } from "@/components/common/WriteGate";
import TicketActionsMenu from "@/components/tickets/TicketActionsMenu";
import TicketExtraActions from "@/components/tickets/TicketExtraActions";
import Badge from "@/components/ui/badge/Badge";
import { Link } from "@/i18n/navigation";
import type { Agent } from "@/server/domain/staff/staff";
import type { TicketDetail } from "@/server/domain/ticket/ticket";
import { stripTags } from "@/server/format/html";

import TicketCreatedNotice from "./TicketCreatedNotice";

interface TicketHeaderProps {
  ticket: TicketDetail;
  agent: Agent;
  locale: string;
  taskCount: number;
  /** URL dell'osTicket PHP (rimando al pannello classico), se configurato */
  legacyUrl?: string;
  /** appena aperto da agente (?created=1): mostra "Ticket creato" */
  created?: boolean;
}

/** Intestazione della vista ticket: ritorno alla lista, oggetto, stato e badge, barre delle azioni. */
export default async function TicketHeader({ ticket, agent, locale, taskCount, legacyUrl, created }: TicketHeaderProps) {
  const t = await getTranslations("ticket");
  const legacyCls = "rounded-lg border border-gray-200 px-3 py-2 text-theme-sm text-gray-600 hover:bg-gray-50 dark:border-gray-800 dark:text-gray-400 dark:hover:bg-white/5";
  // Titolo a sinistra, azioni a destra su una sola fascia (da lg): link al classico ultimo della fascia,
  // gli esiti delle azioni (ActionNotice, order-last) vanno a capo sotto, a tutta larghezza
  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
      <div className="min-w-0 lg:flex-1">
        <Link href="/agent/tickets" className="inline-flex items-center gap-1.5 text-theme-sm text-gray-500 hover:text-brand-500 dark:text-gray-400">
          <ArrowLeft className="size-4 rtl:rotate-180" /> {t("backToList")}
        </Link>
        <h1 className="mt-1 text-title-sm font-semibold break-words text-gray-800 dark:text-white/90">
          #{ticket.number} · {stripTags(ticket.subject)}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Badge color={ticket.status_state === "open" ? "success" : "light"}>{ticket.status_name}</Badge>
          {ticket.priority && (
            <span className="inline-flex items-center gap-1.5 text-theme-sm text-gray-600 dark:text-gray-400">
              <span className="size-2.5 rounded-full ring-1 ring-black/15 dark:ring-white/25" style={{ backgroundColor: ticket.priority_color ?? "#ccc" }} />
              {ticket.priority}
            </span>
          )}
          {ticket.isoverdue && <Badge color="error">{t("overdue")}</Badge>}
          {ticket.isanswered && <Badge color="info">{t("answered")}</Badge>}
          {ticket.locked_by_other && (
            <Badge color="warning" startIcon={<Lock className="size-3" />}>
              {t("locked")}
            </Badge>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 lg:max-w-[60%] lg:shrink-0 lg:justify-end">
        {/* in sola lettura le barre delle azioni non compaiono (il banner del guscio spiega perché) */}
        <WriteGate>
          <TicketActionsMenu ticket={ticket} agent={agent} locale={locale} />
          <TicketExtraActions ticket={ticket} agent={agent} locale={locale} />
        </WriteGate>
        <Link href={`/agent/tasks?ticket=${ticket.ticket_id}`} className={legacyCls}>
          {t("tasks", { count: taskCount })}
        </Link>
        {legacyUrl && (
          <a href={`${legacyUrl}/scp/tickets.php?id=${ticket.ticket_id}`} className={`${legacyCls} whitespace-nowrap`}>
            {t("openLegacy")}
          </a>
        )}
        {created && <TicketCreatedNotice text={t("created")} closeLabel={t("closeNotice")} />}
      </div>
    </div>
  );
}
