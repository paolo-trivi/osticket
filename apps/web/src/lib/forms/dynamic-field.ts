/**
 * Descrizione serializzabile (server → client) dei campi dei form dinamici di osTicket
 * (DynamicFormField), usata dai renderer di `src/components/forms/dynamic/*` sia nel pannello agenti
 * sia nel portale clienti. Nessuna dipendenza dal server: solo dati.
 */
export type DynamicFieldKind =
  | "text"
  | "memo"
  | "choices"
  | "bool"
  | "datetime"
  | "phone"
  | "priority"
  | "department"
  | "list"
  | "thread"
  | "files"
  | "timezone"
  | "info"
  | "break"
  | "unsupported";

export interface DynamicChoice {
  value: string;
  label: string;
}

export interface DynamicFieldView {
  id: number;
  /** nome del campo (variabile) o "" */
  name: string;
  /** chiave usata nel POST del form: `f.<id>` (estensione del telefono: `f.<id>-ext`) */
  key: string;
  kind: DynamicFieldKind;
  /** tipo originale di osTicket (text, memo, list-3, …) */
  type: string;
  /** etichetta in testo semplice */
  label: string;
  hint: string;
  /** obbligatorio per chi compila (agente o cliente) */
  required: boolean;
  choices?: DynamicChoice[];
  multiple?: boolean;
  config: {
    placeholder?: string;
    maxLength?: number;
    rows?: number;
    /** testo ricco (memo HTML, corpo del messaggio) */
    html?: boolean;
    /** data con ora */
    time?: boolean;
    /** telefono con interno */
    ext?: boolean;
    /** descrizione della casella (bool) */
    desc?: string;
    /** contenuto HTML già sanificato (campo informativo) */
    content?: string;
    /** voce vuota delle liste */
    prompt?: string;
    /** valore predefinito */
    defaultValue?: string;
    /** allegati ammessi (corpo del messaggio) */
    attachments?: boolean;
  };
}

export interface DynamicFormView {
  id: number;
  title: string;
  instructions: string;
  fields: DynamicFieldView[];
}

/** Chiave di POST di un campo */
export const fieldKey = (id: number) => `f.${id}`;
