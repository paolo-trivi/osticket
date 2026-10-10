"use client";

import { useCallback, useEffect, useId, useState } from "react";

const EVENT = "tailticket:ticket-notice";

/**
 * Esito di un'azione della vista ticket condiviso tra le barre (azioni, "Gestisci", esito di apertura):
 * se ne vede solo l'ultimo, perché mostrarne uno chiude quelli degli altri componenti.
 */
export function useTicketNotice<T>(initial: T | null = null): [T | null, (value: T | null) => void] {
  const id = useId();
  const [notice, setNotice] = useState<T | null>(initial);
  useEffect(() => {
    const onOther = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== id) setNotice(null);
    };
    window.addEventListener(EVENT, onOther);
    return () => window.removeEventListener(EVENT, onOther);
  }, [id]);
  const show = useCallback(
    (value: T | null) => {
      setNotice(value);
      if (value !== null) window.dispatchEvent(new CustomEvent(EVENT, { detail: id }));
    },
    [id],
  );
  return [notice, show];
}
