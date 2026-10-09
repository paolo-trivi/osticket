"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { editEntryAction, type EditActionState } from "@/app/[locale]/(staff)/agent/(panel)/tickets/[id]/actions-edit";

import EditDialog from "../EditDialog";
import { Editor, Field, Select, TextInput } from "../inputs";
import type { TicketExtraData } from "../types";

/** Modifica di una voce del thread (templates/thread-entry-edit.tmpl.php → TEA_EditThreadEntry). */
export default function EntryEditDialog({ data, onClose, onSuccess }: { data: TicketExtraData; onClose: () => void; onSuccess: (s: EditActionState) => void }) {
  const t = useTranslations("ticketEdit");
  const [id, setId] = useState(data.entries[data.entries.length - 1]?.id ?? 0);
  const entry = data.entries.find((e) => e.id === id);
  const typeLabel = (type: string) => t(`entryTypes.${type}`);
  return (
    <EditDialog ticketId={data.ticketId} title={t("entryTitle", { number: data.number })} action={editEntryAction} submitLabel={t("save")} onClose={onClose} onSuccess={onSuccess} wide>
      <Field label={t("entry")}>
        <Select
          value={String(id)}
          onChange={(v) => setId(Number(v))}
          options={data.entries.map((e) => ({ value: String(e.id), label: `${e.created} · ${typeLabel(e.type)} · ${e.poster}${e.title ? ` · ${e.title}` : ""}` }))}
        />
      </Field>
      <input type="hidden" name="entryId" value={id} />
      {entry && (
        <div key={entry.id} className="space-y-4">
          <Field label={t("entryTitleField")}>
            <TextInput name="title" defaultValue={entry.title} />
          </Field>
          <Editor name="body" defaultValue={entry.body} minHeight={200} />
        </div>
      )}
    </EditDialog>
  );
}
