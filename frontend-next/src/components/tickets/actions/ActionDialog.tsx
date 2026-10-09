"use client";

import { useTranslations } from "next-intl";
import { useActionState, useEffect, type ReactNode } from "react";

import type { TicketActionState } from "@/app/[locale]/(staff)/agent/(panel)/tickets/[id]/actions-assign";
import RichTextEditor from "@/components/editor/RichTextEditor";
import Button from "@/components/ui/button/Button";
import { Modal } from "@/components/ui/modal";
import { useRouter } from "@/i18n/navigation";

export type TicketAction = (prev: TicketActionState, form: FormData) => Promise<TicketActionState>;

interface ActionDialogProps {
  ticketId: number;
  title: string;
  /** messaggio informativo sopra il form (es. assegnatario attuale) */
  notice?: ReactNode;
  action: TicketAction;
  submitLabel: string;
  /** segnaposto del campo commenti; omesso = nessun campo commenti */
  commentsPlaceholder?: string;
  onClose: () => void;
  children?: ReactNode;
}

/** Finestra modale di un'azione: form con server action, commenti opzionali, errori tradotti. */
export default function ActionDialog({ ticketId, title, notice, action, submitLabel, commentsPlaceholder, onClose, children }: ActionDialogProps) {
  const t = useTranslations("ticketActions");
  const tc = useTranslations("composer");
  const router = useRouter();
  const [state, formAction, pending] = useActionState<TicketActionState, FormData>(action, {});

  useEffect(() => {
    if (state.ok) {
      onClose();
      router.refresh();
    }
  }, [state, onClose, router]);

  const error = state.error ? (t.has(`errors.${state.error}`) ? t(`errors.${state.error}`) : t("errors.generic")) : "";

  return (
    <Modal isOpen onClose={onClose} className="m-4 max-w-[600px] p-6 lg:p-8">
      <form action={formAction} className="space-y-5">
        <input type="hidden" name="ticketId" value={ticketId} />
        <h4 className="pe-12 text-title-sm font-semibold text-gray-800 dark:text-white/90">{title}</h4>
        {notice && <div className="rounded-lg bg-blue-light-50 px-4 py-3 text-theme-sm text-blue-light-700 dark:bg-blue-light-500/15 dark:text-blue-light-400">{notice}</div>}
        {error && (
          <div className="rounded-lg bg-error-50 px-4 py-3 text-theme-sm text-error-600 dark:bg-error-500/15 dark:text-error-400">
            {error}
            {state.detail && <span className="block text-theme-xs opacity-80">{state.detail}</span>}
          </div>
        )}
        {children}
        {commentsPlaceholder !== undefined && (
          <RichTextEditor
            name="comments"
            placeholder={commentsPlaceholder}
            minHeight={90}
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
        )}
        <div className="flex items-center justify-end gap-3">
          <Button size="sm" variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button size="sm" type="submit" disabled={pending}>
            {pending ? t("working") : submitLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
