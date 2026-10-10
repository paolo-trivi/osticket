import { getTranslations } from "next-intl/server";

import ComponentCard from "@/components/common/ComponentCard";
import type { TicketDetail } from "@/server/domain/ticket/ticket";
import { formatDbDate } from "@/server/format/datetime";

import InfoRow from "./InfoRow";

interface TicketDetailsCardProps {
  ticket: TicketDetail;
  tz: string;
  locale: string;
}

/** Scheda "Dettagli": reparto, argomento, SLA, origine e date del ticket. */
export default async function TicketDetailsCard({ ticket, tz, locale }: TicketDetailsCardProps) {
  const t = await getTranslations("ticket");
  const tSource = await getTranslations("ticketEdit.sources");
  return (
    <ComponentCard title={t("details")}>
      <dl className="divide-y divide-gray-100 dark:divide-gray-800">
        <InfoRow label={t("department")}>{ticket.dept_name}</InfoRow>
        <InfoRow label={t("helpTopic")}>{ticket.topic_name}</InfoRow>
        <InfoRow label={t("sla")}>{ticket.sla_name}</InfoRow>
        <InfoRow label={t("source")}>{tSource.has(ticket.source) ? tSource(ticket.source) : ticket.source}</InfoRow>
        <InfoRow label={t("created")}>{formatDbDate(ticket.created, tz, locale)}</InfoRow>
        <InfoRow label={t("dueDate")}>{formatDbDate(ticket.duedate ?? ticket.est_duedate, tz, locale)}</InfoRow>
        <InfoRow label={t("lastMessage")}>{formatDbDate(ticket.lastmessage, tz, locale)}</InfoRow>
        <InfoRow label={t("lastResponse")}>{formatDbDate(ticket.lastresponse, tz, locale)}</InfoRow>
        {ticket.closed && <InfoRow label={t("closed")}>{formatDbDate(ticket.closed, tz, locale)}</InfoRow>}
      </dl>
    </ComponentCard>
  );
}
