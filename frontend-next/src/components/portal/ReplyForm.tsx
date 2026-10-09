"use client";

import { useActionState } from "react";

import { useTranslations } from "next-intl";

import RichTextEditor from "@/components/editor/RichTextEditor";
import AttachmentInput from "@/components/forms/AttachmentInput";
import Alert from "@/components/ui/alert/Alert";

import { replyAction, type ReplyState } from "@/app/[locale]/(client)/actions";

import { useEditorLabels } from "./useEditorLabels";

/** Risposta del cliente (view.inc.php, form "Post a Reply"). */
export default function ReplyForm({ ticketId, reopen, attachments, maxFileSize }: { ticketId: number; reopen: boolean; attachments: boolean; maxFileSize: number }) {
  const t = useTranslations("portal.ticket");
  const te = useTranslations("portal.errors");
  const labels = useEditorLabels();
  const [state, action, pending] = useActionState<ReplyState, FormData>(replyAction, {});
  return (
    <form id="reply" action={action} key={state.nonce ?? 0} className="space-y-4 rounded-2xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-white/3">
      <h2 className="text-base font-medium text-gray-800 dark:text-white/90">{t("replyTitle")}</h2>
      <p className="text-theme-sm text-gray-500 dark:text-gray-400">{t("replyHint")}</p>
      {state.error && <Alert variant="error" title={te.has(state.error) ? te(state.error) : state.error} message="" />}
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
