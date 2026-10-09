"use client";

import { useTranslations } from "next-intl";
import { useActionState, useEffect, useRef, useState } from "react";

import { taskNoteAction, taskReplyAction } from "@/app/[locale]/(staff)/agent/(panel)/tasks/actions";
import ComponentCard from "@/components/common/ComponentCard";
import RichTextEditor, { type RichTextEditorHandle } from "@/components/editor/RichTextEditor";
import Button from "@/components/ui/button/Button";
import { useRouter } from "@/i18n/navigation";
import { cn } from "@/utils";

import { FormAlert, SelectField, TextField } from "../FormControls";
import type { PeopleActionState } from "../types";

/** Modulo "Aggiorna/Nota interna" della vista task (task-view.tmpl.php): risposta e nota con cambio di stato. */
export default function TaskComposer({ taskId, isOpen, canReply, canClose, canReopen }: { taskId: number; isOpen: boolean; canReply: boolean; canClose: boolean; canReopen: boolean }) {
  const t = useTranslations("peopleTasks");
  const tu = useTranslations("peopleUi");
  const tc = useTranslations("composer");
  const [mode, setMode] = useState<"reply" | "note">(canReply ? "reply" : "note");
  const editor = useRef<RichTextEditorHandle>(null);
  const router = useRouter();
  const [state, action, pending] = useActionState<PeopleActionState, FormData>(
    (prev, fd) => (fd.get("mode") === "reply" ? taskReplyAction(prev, fd) : taskNoteAction(prev, fd)),
    {},
  );

  useEffect(() => {
    if (state.ok) {
      editor.current?.clear();
      router.refresh();
    }
  }, [state, router]);

  const statusOptions = [
    ...(isOpen && canClose ? [{ id: "closed", name: t("statusClose") }] : []),
    ...(!isOpen && canReopen ? [{ id: "open", name: t("statusReopen") }] : []),
  ];
  const error = state.error ? (tu.has(`errors.${state.error}`) ? tu(`errors.${state.error}`) : tu("errors.generic")) : "";

  return (
    <ComponentCard title={t("post")}>
      <div className="mb-4 flex gap-2">
        {canReply && (
          <button type="button" onClick={() => setMode("reply")} className={cn("rounded-lg px-3 py-2 text-sm font-medium", mode === "reply" ? "bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-400" : "text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/5")}>
            {t("update")}
          </button>
        )}
        <button type="button" onClick={() => setMode("note")} className={cn("rounded-lg px-3 py-2 text-sm font-medium", mode === "note" ? "bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-400" : "text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/5")}>
          {t("internalNote")}
        </button>
      </div>
      <form action={action} className="space-y-4" key={mode}>
        <input type="hidden" name="taskId" value={taskId} />
        <input type="hidden" name="mode" value={mode} />
        {error && <FormAlert kind="error">{error}</FormAlert>}
        {state.ok && <FormAlert kind="success">{mode === "reply" ? t("replyPosted") : t("notePosted")}</FormAlert>}
        {mode === "note" && <TextField name="title" label={t("noteTitle")} maxLength={255} />}
        <RichTextEditor
          ref={editor}
          name={mode === "reply" ? "response" : "note"}
          placeholder={mode === "reply" ? t("replyPlaceholder") : t("notePlaceholder")}
          minHeight={120}
          labels={{
            bold: tc("editor.bold"),
            italic: tc("editor.italic"),
            underline: tc("editor.underline"),
            bullets: tc("editor.bullets"),
            numbers: tc("editor.numbers"),
            link: tc("editor.link"),
            quote: tc("editor.quote"),
            linkPrompt: tc("editor.linkPrompt"),
          }}
        />
        <div className="flex flex-wrap items-end justify-between gap-3">
          {statusOptions.length > 0 ? (
            <div className="w-56">
              <SelectField name="status" label={t("taskStatus")} placeholder={t("statusUnchanged")} options={statusOptions} />
            </div>
          ) : (
            <span />
          )}
          <Button size="sm" type="submit" disabled={pending}>
            {pending ? tu("working") : mode === "reply" ? t("postUpdate") : t("postNote")}
          </Button>
        </div>
      </form>
    </ComponentCard>
  );
}
