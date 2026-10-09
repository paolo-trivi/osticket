"use client";

import { useTranslations } from "next-intl";
import { useActionState, useEffect, useRef, type ReactNode } from "react";

import type { MassActionState } from "@/app/[locale]/(staff)/agent/(panel)/tickets/actions-mass";
import Button from "@/components/ui/button/Button";
import { Modal } from "@/components/ui/modal";

type MassAction = (prev: MassActionState, form: FormData) => Promise<MassActionState>;

/** Modale di un'azione di massa: i ticket scelti viaggiano nei campi nascosti `tids`. */
export default function MassDialog({
  title,
  ids,
  action,
  submitLabel,
  onClose,
  onSuccess,
  warning,
  danger,
  wide,
  children,
}: {
  title: string;
  ids: number[];
  action: MassAction;
  submitLabel: string;
  onClose: () => void;
  onSuccess: (s: MassActionState) => void;
  warning?: ReactNode;
  danger?: boolean;
  wide?: boolean;
  children?: ReactNode;
}) {
  const t = useTranslations("ticketEdit");
  const [state, formAction, pending] = useActionState<MassActionState, FormData>(action, {});
  const done = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (state.ok && done.current !== state.nonce) {
      done.current = state.nonce;
      onSuccess(state);
    }
  }, [state, onSuccess]);
  const err = state.error ? (t.has(`mass.errors.${state.error}`) ? t(`mass.errors.${state.error}`) : t.has(`errors.${state.error}`) ? t(`errors.${state.error}`) : t("errors.generic")) : "";
  return (
    <Modal isOpen onClose={onClose} className={`m-4 ${wide ? "max-w-[760px]" : "max-w-[600px]"} p-6 lg:p-8`}>
      <form action={formAction} className="max-h-[80vh] space-y-5 overflow-y-auto pe-1 custom-scrollbar">
        <h4 className="pe-12 text-title-sm font-semibold text-gray-800 dark:text-white/90">{title}</h4>
        {ids.map((id) => (
          <input key={id} type="hidden" name="tids" value={id} />
        ))}
        {warning && <div className="rounded-lg bg-warning-50 px-4 py-3 text-theme-sm text-warning-700 dark:bg-warning-500/15 dark:text-orange-400">{warning}</div>}
        {err && (
          <div role="alert" className="rounded-lg bg-error-50 px-4 py-3 text-theme-sm text-error-600 dark:bg-error-500/15 dark:text-error-400">
            {err}
          </div>
        )}
        {children}
        <div className="flex items-center justify-end gap-3">
          <Button size="sm" variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
          <button
            type="submit"
            disabled={pending}
            className={`inline-flex items-center justify-center rounded-lg px-4 py-3 text-sm font-medium text-white shadow-theme-xs disabled:opacity-50 ${danger ? "bg-error-500 hover:bg-error-600" : "bg-brand-500 hover:bg-brand-600"}`}
          >
            {pending ? t("working") : submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
