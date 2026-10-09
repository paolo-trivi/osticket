"use client";

import { useActionState, useState, useTransition } from "react";

import { useTranslations } from "next-intl";

import RichTextEditor from "@/components/editor/RichTextEditor";
import AttachmentInput from "@/components/forms/AttachmentInput";
import DynamicForm from "@/components/forms/dynamic/DynamicForm";
import FieldShell from "@/components/forms/dynamic/FieldShell";
import { selectCls } from "@/components/forms/dynamic/styles";
import Alert from "@/components/ui/alert/Alert";
import { Link } from "@/i18n/navigation";
import type { DynamicFormView } from "@/lib/forms/dynamic-field";

import { openTicketAction, portalTopicFormsAction, type OpenState } from "@/app/[locale]/(client)/actions";

import { RICH_CLASS } from "./rich";
import { useEditorLabels } from "./useEditorLabels";

interface Props {
  /** form utente per gli ospiti (null per il cliente autenticato) */
  userForm: DynamicFormView | null;
  ticketForm: DynamicFormView | null;
  topics: { id: number; name: string }[];
  defaultTopic: number;
  initialTopic: { forms: DynamicFormView[]; disabled: number[] };
  client: { name: string; email: string } | null;
  maxFileSize: number;
}

/** Apertura di un ticket dal portale (include/client/open.inc.php). */
export default function OpenTicketForm({ userForm, ticketForm, topics, defaultTopic, initialTopic, client, maxFileSize }: Props) {
  const t = useTranslations("portal.open");
  const te = useTranslations("portal.errors");
  const tf = useTranslations("dynamicForms");
  const labels = useEditorLabels();
  const [state, action, pending] = useActionState<OpenState, FormData>(openTicketAction, {});
  const [topic, setTopic] = useState(initialTopic);
  const [loading, start] = useTransition();
  const changeTopic = (id: number) => start(async () => setTopic(id ? await portalTopicFormsAction(id) : { forms: [], disabled: [] }));

  if (state.created) {
    return (
      <section className="rounded-2xl border border-success-200 bg-white p-6 dark:border-success-800 dark:bg-white/3">
        <h2 className="text-title-sm font-semibold text-gray-800 dark:text-white/90">{t("createdTitle", { number: state.created.number })}</h2>
        {state.created.html ? <div className={`mt-3 ${RICH_CLASS}`} dangerouslySetInnerHTML={{ __html: state.created.html }} /> : <p className="mt-3 text-sm text-gray-600 dark:text-gray-300">{t("createdText")}</p>}
        <Link href="/" className="mt-5 inline-block text-brand-600 hover:underline dark:text-brand-400">
          {t("home")}
        </Link>
      </section>
    );
  }

  const general = state.error ? (te.has(state.error) ? te(state.error) : state.error) : null;
  const err = (k: string) => (state.errors?.[k] ? [te.has(k) ? te(k) : state.errors[k]] : undefined);

  return (
    <form action={action} key={state.nonce ?? 0} className="space-y-6">
      {general && <Alert variant="error" title={general} message="" />}

      <section className="rounded-2xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-white/3">
        {client ? (
          <dl className="grid gap-2 text-theme-sm sm:grid-cols-2">
            <div>
              <dt className="text-gray-500 dark:text-gray-400">{t("client")}</dt>
              <dd className="text-gray-800 dark:text-white/90">{client.name}</dd>
            </div>
            <div>
              <dt className="text-gray-500 dark:text-gray-400">{t("email")}</dt>
              <dd className="text-gray-800 dark:text-white/90">{client.email}</dd>
            </div>
          </dl>
        ) : (
          userForm && <DynamicForm form={userForm} values={state.values} errors={state.fieldErrors} showTitle />
        )}
      </section>

      <section className="space-y-5 rounded-2xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-white/3">
        <FieldShell htmlFor="topicId" label={t("topic")} required errors={err("topicId")}>
          <select id="topicId" name="topicId" defaultValue={state.values?.topicId?.[0] ?? (defaultTopic || "")} className={selectCls} onChange={(e) => changeTopic(Number(e.target.value))}>
            <option value="">{t("selectTopic")}</option>
            {topics.map((tp) => (
              <option key={tp.id} value={tp.id}>
                {tp.name}
              </option>
            ))}
          </select>
        </FieldShell>
        {ticketForm && (
          <DynamicForm
            form={ticketForm}
            values={state.values}
            errors={state.fieldErrors}
            hidden={topic.disabled}
            renderThread={(f) => (
              <div className="space-y-3">
                <FieldShell label={f.label || t("message")} hint={f.hint} required={f.required} errors={state.fieldErrors?.[f.id]?.map((c) => (tf.has(`errors.${c}`) ? tf(`errors.${c}`) : c))}>
                  <RichTextEditor name={f.key} labels={labels} placeholder={t("messagePlaceholder")} defaultValue={state.values?.[f.key]?.[0]} />
                </FieldShell>
                {f.config.attachments && maxFileSize > 0 && <AttachmentInput name="files" uploadUrl="/api/portal/upload" maxSize={maxFileSize} />}
              </div>
            )}
          />
        )}
        {loading && <p className="text-theme-xs text-gray-500 dark:text-gray-400">{t("loadingTopic")}</p>}
        {topic.forms.map((f) => (
          <DynamicForm key={f.id} form={f} values={state.values} errors={state.fieldErrors} showTitle />
        ))}
      </section>

      <div className="flex flex-wrap justify-end gap-3">
        <Link href="/" className="h-11 rounded-lg border border-gray-300 px-5 text-sm leading-11 font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-white/5">
          {t("cancel")}
        </Link>
        <button type="submit" disabled={pending} className="h-11 rounded-lg bg-brand-500 px-6 text-sm font-medium text-white shadow-theme-xs hover:bg-brand-600 disabled:opacity-60">
          {pending ? t("submitting") : t("submit")}
        </button>
      </div>
    </form>
  );
}
