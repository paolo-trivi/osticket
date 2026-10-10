import { getTranslations } from "next-intl/server";

import ComponentCard from "@/components/common/ComponentCard";

import InfoRow from "./InfoRow";

interface TicketAssignmentCardProps {
  /** nome dell'agente assegnatario ("" se non assegnato) */
  assignee: string;
  teamName: string | null;
  /** ruolo dell'agente sul ticket ("" = sola lettura) */
  roleName: string;
}

/** Scheda "Assegnazione": agente, team e ruolo dell'agente corrente sul ticket. */
export default async function TicketAssignmentCard({ assignee, teamName, roleName }: TicketAssignmentCardProps) {
  const t = await getTranslations("ticket");
  return (
    <ComponentCard title={t("assignment")}>
      <dl className="divide-y divide-gray-100 dark:divide-gray-800">
        <InfoRow label={t("assignedTo")}>{assignee}</InfoRow>
        <InfoRow label={t("team")}>{teamName}</InfoRow>
        <InfoRow label={t("yourRole")}>{roleName || t("viewOnly")}</InfoRow>
      </dl>
    </ComponentCard>
  );
}
