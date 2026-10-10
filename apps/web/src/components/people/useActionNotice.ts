"use client";

import { useCallback, useState } from "react";

import type { PeopleAction, PeopleActionState } from "./types";

/**
 * Esito di un'azione dei dialoghi "people" mostrato dal componente chiamante: PeopleDialog si chiude e
 * ricarica la pagina al successo, il messaggio (come $msg del PHP) resta nello stato di chi l'ha aperto.
 * `withNotice` avvolge la server action e, se riesce, imposta il testo calcolato dall'esito e dal form inviato;
 * `show` imposta un esito arrivato da un componente figlio.
 */
export function useActionNotice() {
  const [notice, setNotice] = useState<string | null>(null);
  const clear = useCallback(() => setNotice(null), []);
  const withNotice = useCallback(
    (action: PeopleAction, text: (state: PeopleActionState, form: FormData) => string | null): PeopleAction =>
      async (prev, form) => {
        const state = await action(prev, form);
        if (state.ok) setNotice(text(state, form));
        return state;
      },
    [],
  );
  return { notice, show: setNotice, clear, withNotice };
}
