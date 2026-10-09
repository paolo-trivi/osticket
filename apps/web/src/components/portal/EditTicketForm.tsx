"use client";

import { useActionState } from "react";

import { useTranslations } from "next-intl";

import DynamicForm from "@/components/forms/dynamic/DynamicForm";
import Alert from "@/components/ui/alert/Alert";
import { Link } from "@/i18n/navigation";
import type { DynamicFormView } from "@/lib/forms/dynamic-field";

import { editTicketAction, type EditState } from "@/app/[locale]/(client)/actions";

/** tickets.php?a=edit (edit.inc.php): campi del ticket modificabili dal proprietario. */
export default function EditTicketForm({ ticketId, forms, values }: { ticketId: number; forms: DynamicFormView[]; values: Record<string, string[]> }) {
  const t = useTranslations("portal.ticket");
  const te = useTranslations("portal.errors");
  const [state, action, pending] = useActionState<EditState, FormData>(editTicketAction, {});
  return (
    <form action={action} className="space-y-6">
      {state.error && state.error !== "invalid" && <Alert variant="error" title={te.has(state.error) ? te(state.error) : state.error} message="" />}
      <input type="hidden" name="ticketId" value={ticketId} />
      {forms.map((f) => (
        <section key={f.id} className="rounded-2xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-white/3">
          <DynamicForm form={f} values={state.values ?? values} errors={state.fieldErrors} showTitle />
        </section>
      ))}
      <div className="flex justify-end gap-3">
        <Link href={`/tickets/${ticketId}`} className="h-11 rounded-lg border border-gray-300 px-5 text-sm leading-11 font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-white/5">
          {t("cancel")}
        </Link>
        <button type="submit" disabled={pending} className="h-11 rounded-lg bg-brand-500 px-6 text-sm font-medium text-white shadow-theme-xs hover:bg-brand-600 disabled:opacity-60">
          {t("save")}
        </button>
      </div>
    </form>
  );
}
