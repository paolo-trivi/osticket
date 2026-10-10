"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { updateFieldAction, type EditActionState } from "@/app/[locale]/(staff)/agent/(panel)/tickets/[id]/actions-edit";
import DynamicField from "@/components/forms/dynamic/DynamicField";

import EditDialog from "../EditDialog";
import { Editor, Field, Select, TextInput } from "../inputs";
import type { TicketExtraData } from "../types";

/** Modifica di un solo campo (ajax.tickets.php editField → Ticket::updateField). */
export default function EditFieldDialog({ data, onClose, onSuccess }: { data: TicketExtraData; onClose: () => void; onSuccess: (s: EditActionState) => void }) {
  const t = useTranslations("ticketEdit");
  const e = data.edit;
  const [key, setKey] = useState(e.fields[0]?.key ?? "");
  const field = e.fields.find((f) => f.key === key);
  const label = (f: (typeof e.fields)[number]) => (f.kind === "form" ? f.label : t(f.kind === "duedate" ? "duedate" : f.kind));
  const formField = field?.kind === "form" ? e.forms.flatMap((f) => f.fields).find((f) => f.id === field.fieldId) : undefined;
  return (
    <EditDialog ticketId={data.ticketId} title={t("fieldTitle", { number: data.number })} action={updateFieldAction} submitLabel={t("update")} onClose={onClose} onSuccess={onSuccess}>
      <Field label={t("field")}>
        <Select value={key} onChange={setKey} options={e.fields.map((f) => ({ value: f.key, label: label(f) }))} />
      </Field>
      <input type="hidden" name="field" value={key} />
      <div key={key}>
        {field?.kind === "topic" && (
          <Field label={t("topic")}>
            <Select name="value" defaultValue={String(e.topicId || "")} options={e.topics.map((x) => ({ value: String(x.id), label: x.name }))} required />
          </Field>
        )}
        {field?.kind === "sla" && (
          <Field label={t("sla")}>
            <Select
              name="value"
              defaultValue={String(e.slaId || "")}
              empty={e.slaId ? undefined : t("select")}
              options={e.slas.map((x) => ({
                value: String(x.id),
                label: x.name,
              }))}
              required
            />
          </Field>
        )}
        {field?.kind === "source" && (
          <Field label={t("source")}>
            <Select name="value" defaultValue={e.source} options={e.sources.map((s) => ({ value: s, label: t.has(`sources.${s}`) ? t(`sources.${s}`) : s }))} required />
          </Field>
        )}
        {field?.kind === "duedate" && (
          <Field label={t("duedate")} hint={t("duedateTz")}>
            <TextInput type="datetime-local" name="value" defaultValue={e.duedate} />
          </Field>
        )}
        {formField && <DynamicField field={formField} value={e.values[formField.key]} />}
      </div>
      <Editor name="comments" placeholder={t("reasonPlaceholder")} />
    </EditDialog>
  );
}
