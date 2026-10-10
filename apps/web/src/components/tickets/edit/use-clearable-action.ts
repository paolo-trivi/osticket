"use client";

import { useCallback, useRef, useState } from "react";

import type { EditActionState } from "@/app/[locale]/(staff)/agent/(panel)/tickets/[id]/actions-edit";

type EditAction = (prev: EditActionState, form: FormData) => Promise<EditActionState>;

/**
 * Errore di un EditDialog azzerabile quando l'utente corregge il dato (utente scelto, elenco dei ticket
 * cambiato): `clear()` rimonta il dialogo (`key`) solo se l'ultimo invio è fallito, così lo stato
 * dell'azione torna vuoto. I valori da conservare vanno tenuti fuori dal dialogo.
 */
export function useClearableAction(action: EditAction) {
  const [key, setKey] = useState(0);
  const failed = useRef(false);
  const wrapped = useCallback<EditAction>(
    async (prev, form) => {
      const res = await action(prev, form);
      failed.current = !!res.error;
      return res;
    },
    [action],
  );
  const clear = useCallback(() => {
    if (!failed.current) return;
    failed.current = false;
    setKey((k) => k + 1);
  }, []);
  return { key, action: wrapped, clear };
}
