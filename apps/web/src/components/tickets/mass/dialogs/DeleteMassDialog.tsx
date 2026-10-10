"use client";

import { useTranslations } from "next-intl";

import { massDeleteAction } from "@/app/[locale]/(staff)/agent/(panel)/tickets/actions-mass";
import { Editor } from "@/components/tickets/edit/inputs";

import MassDialog from "../MassDialog";
import type { MassDialogProps } from "../types";

/** Eliminazione di massa, con avviso di operazione irreversibile. */
export default function DeleteMassDialog(common: MassDialogProps) {
  const t = useTranslations("ticketEdit.mass");
  const te = useTranslations("ticketEdit");
  const n = common.ids.length;
  return (
    <MassDialog
      {...common}
      title={t("deleteTitle", { count: n })}
      action={massDeleteAction}
      submitLabel={t("deleteConfirm")}
      danger
      warning={<>{t("deleteWarn", { count: n })} <strong>{te("deleteExtra")}</strong></>}
    >
      <Editor name="comments" placeholder={t("deletePlaceholder", { count: n })} />
    </MassDialog>
  );
}
