"use client";

import { useTranslations } from "next-intl";
import { useActionState, useEffect, useRef, type ReactNode } from "react";

import UndoChange from "@/components/admin/UndoChange";
import Callout from "@/components/common/Callout";
import { ReadOnlyNote, useReadOnlyHint } from "@/components/common/WriteGate";
import Button from "@/components/ui/button/Button";
import { useUndoReload } from "@/components/admin/useUndoReload";
import type { ChangeRef } from "@/lib/changes";
import { submitKeepingValues } from "@/lib/submit-keeping-values";

/** Esito di una server action dell'area adminsys (errori già tradotti, chiave = campo del POST). */
export interface SysFormState {
  status: "idle" | "saved" | "error";
  errors?: Record<string, string>;
  message?: string;
  /** modifica registrata dal salvataggio, da annullare dal banner */
  change?: ChangeRef;
  nonce?: number;
}

const SYS_IDLE: SysFormState = { status: "idle" };

/**
 * Form generico delle pagine admin di sistema: i campi sono passati come children (anche server
 * component) con i nomi del POST di scp/*.php; la server action restituisce gli errori per campo,
 * mostrati in testa con l'etichetta del campo (`labels`).
 */
export default function SysForm({
  action,
  children,
  labels = {},
  submitLabel,
  savedMessage,
  extraButtons,
  resetOnSave = false,
}: {
  action: (prev: SysFormState, form: FormData) => Promise<SysFormState>;
  children: ReactNode;
  labels?: Record<string, string>;
  submitLabel?: string;
  savedMessage?: string;
  extraButtons?: ReactNode;
  resetOnSave?: boolean;
}) {
  const t = useTranslations("asys.common");
  // `saved`: nonce dell'ultimo salvataggio riuscito, chiave del form con resetOnSave (stabile dopo un errore)
  const [state, formAction, pending] = useActionState<SysFormState & { saved?: number }, FormData>(async (prev, form) => {
    const r = await action(prev, form);
    return { ...r, saved: r.status === "saved" ? r.nonce : prev.saved };
  }, SYS_IDLE);
  const banner = useRef<HTMLDivElement>(null);
  // amministrazione non scrivibile (sola lettura o modalità operativa): salvataggio disattivato
  const readOnly = useReadOnlyHint("admin");
  const errors = Object.entries(state.errors ?? {});

  // esito in cima e pulsante in fondo: dopo ogni invio il banner viene portato in vista
  useEffect(() => {
    if (state.status === "idle") return;
    banner.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    banner.current?.focus({ preventScroll: true });
  }, [state]);

  const submit = submitKeepingValues(formAction);
  const undo = useUndoReload();
  const undoneTxt = useTranslations("admChanges")("undone");

  return (
    <div className="space-y-6">
      <div ref={banner} tabIndex={-1} className="scroll-mt-24 outline-none empty:hidden">
        {state.status === "saved" && (
          <Callout tone="success" role="status">
            {undo.isUndone(state.nonce) ? undoneTxt : (state.message ?? savedMessage ?? t("saved"))}
            {state.change && !undo.isUndone(state.nonce) && <UndoChange key={state.nonce} change={state.change} inline onUndone={() => undo.reload(state.nonce)} />}
          </Callout>
        )}
        {state.status === "error" && (
          <Callout tone="error" role="alert">
            <p>{state.message ?? t("fixErrors")}</p>
            {errors.length > 0 && (
              <ul className="mt-2 list-disc ps-5">
                {errors.map(([k, v]) => (
                  <li key={k}>{labels[k] ? `${labels[k]}: ${v}` : v}</li>
                ))}
              </ul>
            )}
          </Callout>
        )}
      </div>
      <form onSubmit={submit} className="space-y-6" key={`${resetOnSave ? (state.saved ?? "") : ""}-${undo.formKey}`}>
        <ReadOnlyNote scope="admin" />
        {children}
        <div className="flex flex-wrap justify-end gap-3">
          {extraButtons}
          <Button type="submit" disabled={pending || !!readOnly} title={readOnly}>
            {pending ? t("saving") : (submitLabel ?? t("save"))}
          </Button>
        </div>
      </form>
    </div>
  );
}
