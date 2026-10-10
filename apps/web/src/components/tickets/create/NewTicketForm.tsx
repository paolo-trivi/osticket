"use client";

import { useActionState, useState, useTransition } from "react";

import { useTranslations } from "next-intl";

import ComponentCard from "@/components/common/ComponentCard";
import RetryAlert from "@/components/common/RetryAlert";
import RichTextEditor from "@/components/editor/RichTextEditor";
import AttachmentInput from "@/components/forms/AttachmentInput";
import DynamicForm from "@/components/forms/dynamic/DynamicForm";
import FieldShell from "@/components/forms/dynamic/FieldShell";
import { Link } from "@/i18n/navigation";
import type { DynamicFormView } from "@/lib/forms/dynamic-field";
import { tryAction } from "@/lib/try-action";

import {
  openTicketAction,
  searchUsersAction,
  topicFormsAction,
  type OpenTicketState,
} from "@/app/[locale]/(staff)/agent/(panel)/tickets/new/actions";

import ResponseSection from "./ResponseSection";
import TicketInfoSection from "./TicketInfoSection";
import type { NewTicketOptions } from "./types";
import UserSection from "./UserSection";

interface Props {
  options: NewTicketOptions;
  uploadUrl: string;
}

/** Form di apertura di un ticket da agente (include/staff/ticket-open.inc.php). */
export default function NewTicketForm({ options, uploadUrl }: Props) {
  const t = useTranslations("createTicket");
  const te = useTranslations("composer");
  const tf = useTranslations("dynamicForms");
  const [state, action, pending] = useActionState<OpenTicketState, FormData>(openTicketAction, {});
  const [topic, setTopic] = useState<{ forms: DynamicFormView[]; disabled: number[] }>({ forms: [], disabled: [] });
  const [loadingTopic, startTopic] = useTransition();

  // argomento il cui caricamento dei form è fallito: messaggio e "Riprova", il resto del modulo resta com'è
  const [topicFailed, setTopicFailed] = useState<number | null>(null);
  const changeTopic = (topicId: number) =>
    startTopic(async () => {
      setTopicFailed(null);
      if (!topicId) return setTopic({ forms: [], disabled: [] });
      const res = await tryAction(() => topicFormsAction(topicId));
      if (res.ok) return setTopic(res.value);
      setTopic({ forms: [], disabled: [] });
      setTopicFailed(topicId);
    });

  const err = (k: keyof NonNullable<OpenTicketState["errors"]>) => (state.errors?.[k] ? t(`errors.${k}`) : undefined);
  const general = state.error ? (t.has(`errors.${state.error}`) ? t(`errors.${state.error}`) : state.error) : null;
  const editorLabels = {
    bold: te("editor.bold"),
    italic: te("editor.italic"),
    underline: te("editor.underline"),
    bullets: te("editor.bullets"),
    numbers: te("editor.numbers"),
    link: te("editor.link"),
    quote: te("editor.quote"),
    linkPrompt: te("editor.linkPrompt"),
  };

  return (
    <form action={action} key={state.nonce ?? 0} className="space-y-6">
      {general && (
        <p role="alert" className="rounded-lg bg-error-50 px-4 py-3 text-theme-sm text-error-700 dark:bg-error-500/15 dark:text-error-400">
          {general}
        </p>
      )}

      <UserSection
        userForm={options.userForm}
        search={searchUsersAction}
        values={state.values}
        fieldErrors={state.fieldErrors}
        errors={{ user: err("user"), email: err("email"), name: err("name") }}
        initialUser={state.user}
        initialCcs={state.ccs}
      />

      <TicketInfoSection
        options={options}
        values={state.values}
        errors={{ topicId: err("topicId"), source: err("source"), duedate: err("duedate"), assignId: err("assignId"), deptId: err("deptId") }}
        onTopicChange={changeTopic}
      />

      <ComponentCard title={t("sections.details")}>
        {options.ticketForm && (
          <DynamicForm
            form={options.ticketForm}
            values={state.values}
            errors={state.fieldErrors}
            hidden={topic.disabled}
            renderThread={(f) => (
              <div className="space-y-3">
                <FieldShell label={f.label || t("details.message")} hint={f.hint} required={f.required} errors={state.fieldErrors?.[f.id]?.map((c) => (tf.has(`errors.${c}`) ? tf(`errors.${c}`) : c))}
                >
                  <RichTextEditor name={f.key} placeholder={t("details.messagePlaceholder")} labels={editorLabels} defaultValue={state.values?.[f.key]?.[0]} />
                </FieldShell>
                {f.config.attachments && options.maxFileSize > 0 && (
                  <FieldShell label={t("details.attachments")}>
                    <AttachmentInput name="files" uploadUrl={uploadUrl} maxSize={options.maxFileSize} />
                  </FieldShell>
                )}
              </div>
            )}
          />
        )}
        {loadingTopic && <p className="text-theme-xs text-gray-500 dark:text-gray-400">{t("details.loadingTopic")}</p>}
        {topicFailed !== null && !loadingTopic && (
          <RetryAlert message={t("details.topicLoadError")} retryLabel={t("details.retry")} onRetry={() => changeTopic(topicFailed)} />
        )}
        {topic.forms.map((f) => (
          <DynamicForm key={f.id} form={f} values={state.values} errors={state.fieldErrors} showTitle />
        ))}
      </ComponentCard>

      <ResponseSection options={options} values={state.values} uploadUrl={uploadUrl} />

      <div className="flex flex-wrap justify-end gap-3">
        <Link
          href="/agent/tickets"
          className="h-11 rounded-lg border border-gray-300 px-5 text-sm leading-11 font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-white/5"
        >
          {t("reset")}
        </Link>
        <button
          type="submit"
          disabled={pending}
          className="h-11 rounded-lg bg-brand-500 px-6 text-sm font-medium text-white shadow-theme-xs hover:bg-brand-600 disabled:opacity-60"
        >
          {pending ? t("submitting") : t("submit")}
        </button>
      </div>
    </form>
  );
}
