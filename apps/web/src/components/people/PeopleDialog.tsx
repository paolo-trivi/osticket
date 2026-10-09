"use client";

import { useTranslations } from "next-intl";
import { useActionState, useEffect, type ReactNode } from "react";

import RichTextEditor from "@/components/editor/RichTextEditor";
import Button from "@/components/ui/button/Button";
import { Modal } from "@/components/ui/modal";
import { useRouter } from "@/i18n/navigation";

import { FormAlert } from "./FormControls";
import type { PeopleAction, PeopleActionState } from "./types";

interface PeopleDialogProps {
  title: string;
  action: PeopleAction;
  submitLabel: string;
  onClose: () => void;
  /** campi nascosti inviati con il form (id dell'oggetto…) */
  hidden?: Record<string, string | number>;
  /** avviso sopra il form */
  notice?: ReactNode;
  /** segnaposto del campo HTML "comments"; omesso = nessun campo commenti */
  commentsPlaceholder?: string;
  /** nome del campo HTML (default "comments") */
  commentsName?: string;
  danger?: boolean;
  wide?: boolean;
  /** contenuto del form; può essere una funzione dello stato (errori per campo) */
  children?: ReactNode | ((state: PeopleActionState) => ReactNode);
}

/** Finestra modale con form e server action: errori tradotti, chiusura e refresh al successo. */
export default function PeopleDialog({ title, action, submitLabel, onClose, hidden, notice, commentsPlaceholder, commentsName = "comments", danger, wide, children }: PeopleDialogProps) {
  const t = useTranslations("peopleUi");
  const tc = useTranslations("composer");
  const router = useRouter();
  const [state, formAction, pending] = useActionState<PeopleActionState, FormData>(action, {});

  useEffect(() => {
    if (!state.ok) return;
    onClose();
    if (state.redirect) router.push(state.redirect);
    else router.refresh();
  }, [state, onClose, router]);

  const error = state.error ? (t.has(`errors.${state.error}`) ? t(`errors.${state.error}`) : t("errors.generic")) : "";

  return (
    <Modal isOpen onClose={onClose} className={wide ? "m-4 max-w-[820px] p-6 lg:p-8" : "m-4 max-w-[600px] p-6 lg:p-8"}>
      <form action={formAction} className="max-h-[80vh] space-y-5 overflow-y-auto custom-scrollbar pe-1">
        {Object.entries(hidden ?? {}).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <h4 className="pe-12 text-title-sm font-semibold text-gray-800 dark:text-white/90">{title}</h4>
        {notice && <FormAlert kind={danger ? "warning" : "info"}>{notice}</FormAlert>}
        {error && <FormAlert kind="error">{error}</FormAlert>}
        {typeof children === "function" ? children(state) : children}
        {commentsPlaceholder !== undefined && (
          <RichTextEditor
            name={commentsName}
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
          <Button size="sm" type="submit" disabled={pending} className={danger ? "bg-error-500 hover:bg-error-600" : ""}>
            {pending ? t("working") : submitLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
