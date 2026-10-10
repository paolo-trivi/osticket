import type { Opt } from "./form-schema";

/**
 * Valori che la UI non conosce (plugin di osTicket, opzioni del PHP non replicate, riferimenti a
 * oggetti non più elencati): un form di TailTicket non deve mai riscriverli solo perché non sa
 * rappresentarli. Una select il cui valore non è tra le opzioni farebbe inviare al browser la prima
 * opzione; per questo il valore attuale si aggiunge sempre all'elenco, e la validazione lato server
 * accetta il valore attuale invariato anche se non è tra quelli noti.
 */

const present = (v: string | null | undefined): v is string => v !== null && v !== undefined && v !== "";

/**
 * Opzioni di un campo select/radio con in più il valore attuale, se non vuoto e non già presente.
 * `label` dà l'etichetta del valore sconosciuto (es. "ldap (valore attuale)").
 */
export function withCurrentOption<T extends Opt>(options: T[], current: string | null | undefined, label: (value: string) => string): (T | Opt)[] {
  if (!present(current) || options.some((o) => o.value === current)) return options;
  return [...options, { value: current, label: label(current) }];
}

/**
 * Validazione di un elenco chiuso che preserva il valore attuale: il valore inviato è ammesso se è
 * tra quelli noti oppure se è uguale al valore attuale (non vuoto) non modificato dall'utente.
 */
export function isKnownOrCurrent(value: string, known: readonly string[], current: string | null | undefined): boolean {
  return known.includes(value) || (present(current) && value === current);
}
