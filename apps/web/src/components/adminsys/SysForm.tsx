"use client";

import { useTranslations } from "next-intl";
import { useActionState, type ReactNode } from "react";

import Callout from "@/components/common/Callout";
import Button from "@/components/ui/button/Button";

/** Esito di una server action dell'area adminsys (errori già tradotti, chiave = campo del POST). */
export interface SysFormState {
  status: "idle" | "saved" | "error";
  errors?: Record<string, string>;
  message?: string;
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
  const [state, formAction, pending] = useActionState(action, SYS_IDLE);
  const errors = Object.entries(state.errors ?? {});
  return (
    <form action={formAction} className="space-y-6" key={resetOnSave && state.status === "saved" ? state.nonce : undefined}>
      {state.status === "saved" && (
        <Callout tone="success" role="status">
          {state.message ?? savedMessage ?? t("saved")}
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
      {children}
      <div className="flex flex-wrap justify-end gap-3">
        {extraButtons}
        <Button type="submit" disabled={pending}>
          {pending ? t("saving") : (submitLabel ?? t("save"))}
        </Button>
      </div>
    </form>
  );
}
