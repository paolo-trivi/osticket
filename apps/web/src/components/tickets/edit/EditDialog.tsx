"use client";

import { useTranslations } from "next-intl";
import { useActionState, useEffect, useRef, type ReactNode } from "react";

import type { EditActionState } from "@/app/[locale]/(staff)/agent/(panel)/tickets/[id]/actions-edit";
import Button from "@/components/ui/button/Button";
import { Modal } from "@/components/ui/modal";

type EditAction = (prev: EditActionState, form: FormData) => Promise<EditActionState>;

const box = "rounded-lg px-4 py-3 text-theme-sm";

/** Messaggio d'errore tradotto (ticketEdit.errors.<codice>) con gli eventuali errori dei campi. */
export function EditErrorBox({ state }: { state: EditActionState }) {
  const t = useTranslations("ticketEdit");
  if (!state.error) return null;
  const msg = (code: string) => (t.has(`errors.${code}`) ? t(`errors.${code}`) : t("errors.generic"));
  const fieldMsg = (code: string) => (t.has(`fieldErrors.${code}`) ? t(`fieldErrors.${code}`) : code);
  return (
    <div role="alert" className={`${box} bg-error-50 text-error-600 dark:bg-error-500/15 dark:text-error-400`}>
      {msg(state.error)}
      {state.fields && (
        <ul className="mt-1 list-disc ps-5 text-theme-xs">
          {Object.entries(state.fields).map(([k, codes]) => (
            <li key={k}>
              {t.has(`fieldNames.${k.replace(/^field\.\d+$/, "field")}`) ? t(`fieldNames.${k.replace(/^field\.\d+$/, "field")}`) : k}: {codes.map(fieldMsg).join(", ")}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface Props {
  ticketId: number;
  title: string;
  action: EditAction;
  submitLabel: string;
  onClose: () => void;
  onSuccess: (state: EditActionState) => void;
  /** avviso (giallo) sopra il form */
  warning?: ReactNode;
  /** pulsante di conferma rosso (eliminazione) */
  danger?: boolean;
  wide?: boolean;
  children?: ReactNode;
}

/** Finestra modale con form e server action dell'area "ticketedit". */
export default function EditDialog({ ticketId, title, action, submitLabel, onClose, onSuccess, warning, danger, wide, children }: Props) {
  const t = useTranslations("ticketEdit");
  const [state, formAction, pending] = useActionState<EditActionState, FormData>(action, {});
  const done = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (state.ok && done.current !== state.nonce) {
      done.current = state.nonce;
      onSuccess(state);
    }
  }, [state, onSuccess]);

  return (
    <Modal isOpen onClose={onClose} className={`m-4 ${wide ? "max-w-[840px]" : "max-w-[600px]"} p-6 lg:p-8`}>
      <form action={formAction} className="max-h-[80vh] space-y-5 overflow-y-auto pe-1 custom-scrollbar">
        <h4 className="pe-12 text-title-sm font-semibold text-gray-800 dark:text-white/90">{title}</h4>
        <input type="hidden" name="ticketId" value={ticketId} />
        {warning && <div className={`${box} bg-warning-50 text-warning-700 dark:bg-warning-500/15 dark:text-orange-400`}>{warning}</div>}
        <EditErrorBox state={state} />
        {children}
        <div className="flex items-center justify-end gap-3">
          <Button size="sm" variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
          <button
            type="submit"
            disabled={pending}
            className={`inline-flex items-center justify-center rounded-lg px-4 py-3 text-sm font-medium text-white shadow-theme-xs disabled:opacity-50 ${
              danger ? "bg-error-500 hover:bg-error-600" : "bg-brand-500 hover:bg-brand-600"
            }`}
          >
            {pending ? t("working") : submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
