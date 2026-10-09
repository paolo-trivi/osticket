import type { DynamicFormView } from "@/lib/forms/dynamic-field";

/** Dati del form di apertura da agente preparati dal server (opzioni e form dinamici). */
export interface NewTicketOptions {
  topics: { id: number; name: string }[];
  depts: { id: number; name: string }[];
  slas: { id: number; name: string }[];
  agents: { id: number; name: string }[];
  teams: { id: number; name: string }[];
  statuses: { id: number; name: string; state: string }[];
  hasMySignature: boolean;
  ticketForm: DynamicFormView | null;
  userForm: DynamicFormView | null;
  /** dimensione massima degli allegati (0 = allegati disattivati) */
  maxFileSize: number;
}

/** Valori inviati in precedenza, per chiave del POST */
export type SubmittedValues = Record<string, string[]>;

export const first = (values: SubmittedValues | undefined, key: string) => values?.[key]?.[0] ?? "";
