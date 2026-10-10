"use client";

import { useTranslations } from "next-intl";

import { massTransferAction } from "@/app/[locale]/(staff)/agent/(panel)/tickets/actions-mass";
import { Editor, Field, Select } from "@/components/tickets/edit/inputs";

import MassDialog from "../MassDialog";
import type { MassData, MassDialogProps } from "../types";

/** Trasferimento di massa a un reparto. */
export default function TransferMassDialog({ depts, ...common }: MassDialogProps & { depts: MassData["depts"] }) {
  const t = useTranslations("ticketEdit.mass");
  return (
    <MassDialog {...common} title={t("transferTitle", { count: common.ids.length })} action={massTransferAction} submitLabel={t("transfer")}>
      <Field label={t("dept")}>
        <Select name="dept" defaultValue="" empty={t("selectDept")} required options={depts.map((d) => ({ value: String(d.id), label: d.name }))} />
      </Field>
      <Editor name="comments" placeholder={t("commentsPlaceholder")} />
    </MassDialog>
  );
}
