"use client";

import { useTranslations } from "next-intl";

import { massClaimAction } from "@/app/[locale]/(staff)/agent/(panel)/tickets/actions-mass";
import { Editor } from "@/components/tickets/edit/inputs";

import MassDialog from "../MassDialog";
import type { MassDialogProps } from "../types";

/** Presa in carico di massa dei ticket selezionati. */
export default function ClaimMassDialog(common: MassDialogProps) {
  const t = useTranslations("ticketEdit.mass");
  const n = common.ids.length;
  return (
    <MassDialog {...common} title={t("claimTitle", { count: n })} action={massClaimAction} submitLabel={t("claimConfirm")} warning={t("claimWarn", { count: n })}>
      <Editor name="comments" placeholder={t("commentsPlaceholder")} />
    </MassDialog>
  );
}
