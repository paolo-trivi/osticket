"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

import { massAssignAction, massAssigneesAction } from "@/app/[locale]/(staff)/agent/(panel)/tickets/actions-mass";
import { Editor, Field, Select } from "@/components/tickets/edit/inputs";

import MassDialog from "../MassDialog";
import type { MassDialogProps } from "../types";

/** Assegnazione di massa a un agente o a un team (le scelte arrivano dal server per i ticket selezionati). */
export default function AssignMassDialog({ ids, what, onClose, onSuccess }: MassDialogProps & { what: "agents" | "teams" }) {
  const t = useTranslations("ticketEdit.mass");
  const [options, setOptions] = useState<{ value: string; label: string }[] | null>(null);
  useEffect(() => {
    void massAssigneesAction(ids, what).then(setOptions);
  }, [ids, what]);
  return (
    <MassDialog ids={ids} onClose={onClose} onSuccess={onSuccess} title={t("assignTitle", { count: ids.length })} action={massAssignAction} submitLabel={t("assign")}>
      {options === null ? (
        <p className="text-theme-sm text-gray-500">{t("loading")}</p>
      ) : options.length === 0 ? (
        <p className="text-theme-sm text-warning-600">{t(what === "agents" ? "noAgents" : "noTeams")}</p>
      ) : (
        <Field label={t(what === "agents" ? "agent" : "team")}>
          <Select name="assignee" defaultValue="" empty={t(what === "agents" ? "selectAgent" : "selectTeam")} required options={options} />
        </Field>
      )}
      <Editor name="comments" placeholder={t("commentsPlaceholder")} />
    </MassDialog>
  );
}
