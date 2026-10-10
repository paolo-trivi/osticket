import { getTranslations, setRequestLocale } from "next-intl/server";

import EditTicketForm from "@/components/portal/EditTicketForm";
import { redirect } from "@/i18n/navigation";
import { fieldKey, type DynamicFormView } from "@/lib/forms/dynamic-field";
import { parseId } from "@/lib/route-id";
import { coreConfig } from "@/server/config/config";
import { clientEditForms } from "@/server/domain/client/ticket-edit";
import { loadClientTicketView } from "@/server/domain/client/ticket-view";
import { fieldToString, isIdValue } from "@/server/domain/forms/fields";
import { fieldView } from "@/server/domain/ticket/create-ui";

import { requireClient } from "../../../guard";

export async function generateMetadata() {
  const t = await getTranslations("portal.ticket");
  return { title: t("edit") };
}

/** Modifica dei campi del ticket da parte del proprietario (solo campi visibili e modificabili dai clienti). */
export default async function EditClientTicketPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const client = await requireClient(locale, `/tickets/${id}/edit`);
  const cfg = await coreConfig();
  const ticketId = parseId(id) ?? 0;
  const view = await loadClientTicketView(cfg, client, ticketId);
  if (!view || !view.canEdit) redirect({ href: `/tickets/${ticketId}`, locale });
  const t = await getTranslations("portal.ticket");
  const entries = await clientEditForms(cfg, ticketId);
  const forms: DynamicFormView[] = [];
  const values: Record<string, string[]> = {};
  for (const e of entries) {
    const fields = e.fields.map((f) => fieldView(f, "client")).filter((f): f is NonNullable<typeof f> => !!f && f.kind !== "thread");
    if (!fields.length) continue;
    forms.push({ id: e.entryId, title: e.title, instructions: "", fields });
    for (const f of e.fields) {
      const v = e.values.get(f.id);
      if (v === undefined || v === null) continue;
      if (typeof v === "object" && isIdValue(v)) values[fieldKey(f.id)] = [String(v.id)];
      else if (typeof v === "object") values[fieldKey(f.id)] = Object.keys(v);
      else values[fieldKey(f.id)] = [fieldToString(f, v)];
    }
  }
  return (
    <div className="space-y-6">
      <h1 className="text-title-sm font-semibold text-gray-800 dark:text-white/90">
        {t("edit")} #{view!.number}
      </h1>
      <EditTicketForm ticketId={ticketId} forms={forms} values={values} />
    </div>
  );
}
