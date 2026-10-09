/** Stato restituito dalle server action dell'area "people" (task, utenti, organizzazioni, profilo). */
export interface PeopleActionState {
  ok?: boolean;
  /** codice d'errore (tradotto con peopleUi.errors.<codice>) */
  error?: string;
  /** errori per campo: nome campo → codice (peopleUi.fieldErrors.<codice>) */
  fields?: Record<string, string>;
  /** messaggio di esito (chiave peopleUi.done.<codice>) */
  notice?: string;
  /** percorso su cui spostarsi dopo il successo */
  redirect?: string;
  count?: number;
  nonce?: number;
}

export type PeopleAction = (prev: PeopleActionState, form: FormData) => Promise<PeopleActionState>;

export interface Choice {
  id: number | string;
  name: string;
}

/** Campo di un form dinamico (utente/organizzazione/task) serializzabile per il client. */
export interface DynField {
  id: number;
  name: string;
  label: string;
  type: string;
  required: boolean;
  hint: string | null;
  choices?: Record<string, string>;
  value: string;
}
