"use client";

import { useTranslations } from "next-intl";
import { useActionState, useEffect, useRef, type ReactNode } from "react";

import type { TicketActionState } from "@/app/[locale]/(staff)/agent/(panel)/tickets/[id]/actions-assign";
import RichTextEditor from "@/components/editor/RichTextEditor";
import Button from "@/components/ui/button/Button";
import { Modal } from "@/components/ui/modal";

export type TicketAction = (prev: TicketActionState, form: FormData) => Promise<TicketActionState>;

interface ActionDialogProps {
  ticketId: number;
  title: string;
  /** messaggio informativo sopra il form (es. assegnatario attuale) */
  notice?: ReactNode;
  /** avviso (giallo) sopra il form, es. Ticket::isCloseable() */
  warning?: ReactNode;
  action: TicketAction;
  submitLabel: string;
  /** segnaposto del campo commenti; omesso = nessun campo commenti */
  commentsPlaceholder?: string;
  onClose: () => void;
  /** azione riuscita (dopo l'eventuale conferma dell'avviso): chiusura, messaggio e aggiornamento */
  onSuccess: (state: TicketActionState) => void;
  /** contenuto fuori dal form principale (es. gestione dei referral, con un proprio form) */
  aside?: ReactNode;
  children?: ReactNode;
}

const box = "rounded-lg px-4 py-3 text-theme-sm";

/** Messaggio d'errore tradotto di un'azione (chiave errors.<codice>, altrimenti generico). */
export function useActionError() {
  const t = useTranslations("ticketActions");
  return (state: TicketActionState) => (state.error ? (t.has(`errors.${state.error}`) ? t(`errors.${state.error}`) : t("errors.generic")) : "");
}

/** Riquadro d'errore con l'eventuale dettaglio tecnico (messaggio del dominio). */
export function ErrorBox({ state }: { state: TicketActionState }) {
  const errorOf = useActionError();
  const error = errorOf(state);
  if (!error) return null;
  return (
    <div role="alert" className={`${box} bg-error-50 text-error-600 dark:bg-error-500/15 dark:text-error-400`}>
      {error}
      {/* dettaglio del dominio (testo PHP in inglese) solo per gli errori generici */}
      {state.detail && state.error === "status_failed" && <span className="block text-theme-xs opacity-80">{state.detail}</span>}
    </div>
  );
}

/**
 * Finestra modale di un'azione: form con server action, commenti opzionali, errori tradotti.
 * Con esito positivo chiama onSuccess; se il dominio restituisce un avviso (es. figli non aggiornati)
 * lo mostra e attende la chiusura esplicita.
 */
export default function ActionDialog({
  ticketId,
  title,
  notice,
  warning,
  action,
  submitLabel,
  commentsPlaceholder,
  onClose,
  onSuccess,
  aside,
  children,
}: ActionDialogProps) {
  const t = useTranslations("ticketActions");
  const tc = useTranslations("composer");
  const [state, formAction, pending] = useActionState<TicketActionState, FormData>(action, {});
  const done = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (state.ok && !state.warn && done.current !== state.nonce) {
      done.current = state.nonce;
      onSuccess(state);
    }
  }, [state, onSuccess]);

  const warned = state.ok && !!state.warn;

  return (
    <Modal isOpen onClose={warned ? () => onSuccess(state) : onClose} className="m-4 max-w-[600px] p-6 lg:p-8">
      <div className="space-y-5">
        <h4 className="pe-12 text-title-sm font-semibold text-gray-800 dark:text-white/90">{title}</h4>
        {warned ? (
          <>
            <div role="status" className={`${box} bg-warning-50 text-warning-700 dark:bg-warning-500/15 dark:text-orange-400`}>
              {t("childrenFailed", { tickets: state.warn ?? "" })}
            </div>
            <div className="flex justify-end">
              <Button size="sm" onClick={() => onSuccess(state)}>
                {t("close")}
              </Button>
            </div>
          </>
        ) : (
          <>
            {aside}
            <form action={formAction} className="space-y-5">
              <input type="hidden" name="ticketId" value={ticketId} />
              {notice && <div className={`${box} bg-blue-light-50 text-blue-light-700 dark:bg-blue-light-500/15 dark:text-blue-light-400`}>{notice}</div>}
              {warning && <div className={`${box} bg-warning-50 text-warning-700 dark:bg-warning-500/15 dark:text-orange-400`}>{warning}</div>}
              <ErrorBox state={state} />
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
          </>
        )}
      </div>
    </Modal>
  );
}
