import { getTranslations } from "next-intl/server";

import ComponentCard from "@/components/common/ComponentCard";
import type { TicketDetail } from "@/server/domain/ticket/ticket";

import InfoRow from "./InfoRow";

/** Scheda "Utente": contatti dell'utente del ticket e organizzazione. */
export default async function TicketUserCard({ ticket }: { ticket: TicketDetail }) {
  const t = await getTranslations("ticket");
  return (
    <ComponentCard title={t("user")}>
      <dl className="divide-y divide-gray-100 dark:divide-gray-800">
        <InfoRow label={t("name")}>{ticket.user_name}</InfoRow>
        <InfoRow label={t("email")}>{ticket.user_email}</InfoRow>
        <InfoRow label={t("phone")}>{ticket.user_phone}</InfoRow>
        <InfoRow label={t("organization")}>{ticket.org_name}</InfoRow>
      </dl>
    </ComponentCard>
  );
}
