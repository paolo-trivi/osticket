"use client";

import { useState, useTransition } from "react";

import { useRouter } from "@/i18n/navigation";

/**
 * "Annulla modifica" nei form admin (AdminForm, SysForm): dopo l'annullamento il form si rimonta con i
 * valori ripristinati (`formKey`, stessa transizione del refresh) e l'esito del salvataggio annullato
 * (`isUndone(nonce)`) mostra "Modifica annullata" al posto di "Modifiche salvate".
 */
export function useUndoReload() {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [undone, setUndone] = useState<{ count: number; nonce?: number }>({ count: 0 });
  const reload = (nonce: number | undefined) =>
    startTransition(() => {
      router.refresh();
      setUndone((u) => ({ count: u.count + 1, nonce }));
    });
  return { formKey: undone.count, isUndone: (nonce: number | undefined) => undone.count > 0 && undone.nonce === nonce, reload };
}
