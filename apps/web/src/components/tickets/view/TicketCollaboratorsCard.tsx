import { getTranslations } from "next-intl/server";

import ComponentCard from "@/components/common/ComponentCard";
import type { TicketCollaborator } from "@/server/domain/ticket/view";

/** Scheda "Collaboratori" del thread (i disattivati barrati). */
export default async function TicketCollaboratorsCard({ collaborators }: { collaborators: TicketCollaborator[] }) {
  const t = await getTranslations("ticket");
  return (
    <ComponentCard title={t("collaborators")}>
      <ul className="space-y-1 text-sm">
        {collaborators.map((c) => (
          <li key={c.id} className={c.active ? "text-gray-800 dark:text-white/90" : "text-gray-400 line-through"}>
            {c.name} {c.email && <span className="text-gray-500">&lt;{c.email}&gt;</span>}
          </li>
        ))}
      </ul>
    </ComponentCard>
  );
}
