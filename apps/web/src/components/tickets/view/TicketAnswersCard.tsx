import { getTranslations } from "next-intl/server";

import ComponentCard from "@/components/common/ComponentCard";
import type { TicketAnswer } from "@/server/domain/ticket/view";

import InfoRow from "./InfoRow";

/** Scheda "Campi aggiuntivi": risposte dei form dinamici del ticket. */
export default async function TicketAnswersCard({ answers }: { answers: TicketAnswer[] }) {
  const t = await getTranslations("ticket");
  return (
    <ComponentCard title={t("additionalFields")}>
      <dl className="divide-y divide-gray-100 dark:divide-gray-800">
        {answers.map((a) => (
          <InfoRow key={`${a.form_title}-${a.name}`} label={a.label}>
            {a.value}
          </InfoRow>
        ))}
      </dl>
    </ComponentCard>
  );
}
