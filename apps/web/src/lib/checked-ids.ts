import { useSyncExternalStore } from "react";

/**
 * Id delle caselle selezionate nelle liste con azioni di massa (solo browser): `selector` individua le
 * caselle, il valore è l'id. Senza duplicati (una lista può avere più viste con le stesse caselle) e
 * senza valori non numerici o nulli.
 */
export function checkedIds(selector: string): number[] {
  const values = [...document.querySelectorAll<HTMLInputElement>(`${selector}:checked`)].map((i) => Number(i.value));
  return [...new Set(values)].filter(Boolean);
}

/**
 * Cambi delle caselle: l'evento "change" (anche quello della casella "seleziona tutto": l'onChange di React
 * per le checkbox gira sul click, prima del change nativo, quindi le righe sono già impostate) e le
 * modifiche del DOM, perché dopo un refresh le righe elaborate spariscono senza emettere eventi.
 */
const subscribeToChanges = (onChange: () => void) => {
  document.addEventListener("change", onChange);
  const observer = new MutationObserver(onChange);
  observer.observe(document.body, { childList: true, subtree: true });
  return () => {
    document.removeEventListener("change", onChange);
    observer.disconnect();
  };
};

/**
 * Quante righe sono selezionate (`selector` come in checkedIds), aggiornato a ogni cambio di una casella:
 * le caselle stanno nelle tabelle server, fuori dallo stato React. Lato server vale 0.
 */
export function useCheckedCount(selector: string): number {
  return useSyncExternalStore(
    subscribeToChanges,
    () => checkedIds(selector).length,
    () => 0,
  );
}
