"use client";

import { useActionState } from "react";

import { useTranslations } from "next-intl";

import RichTextEditor from "@/components/editor/RichTextEditor";
import AttachmentInput from "@/components/forms/AttachmentInput";
import { ReadOnlyNotice, WriteGate } from "@/components/common/WriteGate";
import Alert from "@/components/ui/alert/Alert";

import { replyAction, type ReplyState } from "@/app/[locale]/(client)/actions";

import { useEditorLabels } from "./useEditorLabels";
import { submitKeepingValues } from "@/lib/submit-keeping-values";

type ReplyFormProps = {
  ticketId: number;
  reopen: boolean;
  attachments: boolean;
  maxFileSize: number;
  posted?: boolean;
};

/** In sola lettura un avviso per i clienti prende il posto del form. */
export default function ReplyForm(props: ReplyFormProps) {
  return (
    <WriteGate fallback={<ReadOnlyNotice portal />}>
      <ReplyFormInner {...props} />
    </WriteGate>
  );
}

/**
 * Risposta del cliente (view.inc.php, form "Post a Reply"). Dopo un invio riuscito la pagina rimonta il
 * form (key) e mostra l'esito qui (`posted`), dove porta il redirect a #reply.
 */
function ReplyFormInner({ ticketId, reopen, attachments, maxFileSize, posted }: ReplyFormProps) {
  const t = useTranslations("portal.ticket");
  const te = useTranslations("portal.errors");
  const labels = useEditorLabels();
  const [state, action, pending] = useActionState<ReplyState, FormData>(replyAction, {});
  const submit = submitKeepingValues(action);
  return (
    <form id="reply" onSubmit={submit} className="scroll-mt-24 space-y-4 rounded-2xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-white/3">
      <h2 className="text-base font-medium text-gray-800 dark:text-white/90">{t("replyTitle")}</h2>
      {posted && !state.error && (
        <div>
          <Alert variant="success" title={t("posted")} message="" />
        </div>
      )}
      <p className="text-theme-sm text-gray-500 dark:text-gray-400">{t("replyHint")}</p>
      {state.error && (
        <div>
          <Alert variant="error" title={te.has(state.error) ? te(state.error) : state.error} message="" />
        </div>
      )}
      <input type="hidden" name="ticketId" value={ticketId} />
      <RichTextEditor name="message" labels={labels} placeholder={t("replyPlaceholder")} />
      {attachments && maxFileSize > 0 && <AttachmentInput name="files" uploadUrl="/api/portal/upload" maxSize={maxFileSize} />}
      {reopen && <Alert variant="warning" title={t("reopenOnReply")} message="" />}
      <div className="flex justify-end">
        <button type="submit" disabled={pending} className="h-11 rounded-lg bg-brand-500 px-6 text-sm font-medium text-white shadow-theme-xs hover:bg-brand-600 disabled:opacity-60">
          {pending ? t("posting") : t("post")}
        </button>
      </div>
    </form>
  );
}
