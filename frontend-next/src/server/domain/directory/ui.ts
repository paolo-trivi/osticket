import "server-only";

import { db, type DbOrTx } from "../../db";
import { defaultFormOf, entriesFor, fieldChoices, hasData, isEditableToStaff, isRequiredForStaff, isVisibleToStaff, toPhp, type FieldDef, type FormEntry } from "./forms";

/**
 * Dati per i form della UI (utenti, organizzazioni, task): campi dei form dinamici con i valori
 * attuali, serializzabili per i componenti client.
 */
export interface DynFieldData {
  id: number;
  name: string;
  label: string;
  type: string;
  required: boolean;
  hint: string | null;
  choices?: Record<string, string>;
  value: string;
}

const PRESENTATION = new Set(["thread", "break", "info"]);

function valueOf(f: FieldDef, raw: string | null): string {
  const v = toPhp(f, raw);
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "1" : "";
  if (typeof v === "object") return Object.keys(v)[0] ?? "";
  return String(v);
}

/** Campi visibili all'agente di un form (con filtro facoltativo, es. modificabili). */
export function toDynFields(fields: FieldDef[], values: Record<string, string> = {}, filter: (f: FieldDef) => boolean = isVisibleToStaff): DynFieldData[] {
  return fields
    .filter((f) => hasData(f) && !PRESENTATION.has(f.type) && filter(f))
    .map((f) => ({
      id: f.id,
      name: f.name,
      label: f.label,
      type: f.type,
      required: isRequiredForStaff(f),
      hint: f.hint,
      ...(f.type === "choices" ? { choices: fieldChoices(f) } : {}),
      value: values[f.name || String(f.id)] ?? "",
    }));
}

/** Campi del form predefinito (vuoti) per la creazione. */
export async function newFormFields(type: "U" | "O", executor: DbOrTx = db()): Promise<DynFieldData[]> {
  const form = await defaultFormOf(executor, type);
  return form ? toDynFields(form.fields) : [];
}

/** Valori correnti delle entry di un oggetto per i campi modificabili dall'agente. */
export function entryValues(entries: FormEntry[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of entries) {
    for (const f of e.fields) {
      const a = e.answers.get(f.id);
      if (a?.exists) out[f.name || String(f.id)] ??= valueOf(f, a.value);
    }
  }
  return out;
}

/**
 * Campi modificabili di un oggetto (User::getForms / Organization::getForms): i campi "name" ed "email"
 * non memorizzati nelle risposte prendono il valore dall'oggetto.
 */
export async function editFormFields(objectType: "U" | "O" | "A", objectId: number, base: Record<string, string>, executor: DbOrTx = db()): Promise<DynFieldData[]> {
  const entries = await entriesFor(executor, objectType, objectId);
  if (!entries.length) {
    const form = await defaultFormOf(executor, objectType);
    return form ? toDynFields(form.fields, base, isEditableToStaff) : [];
  }
  const values = { ...entryValues(entries), ...base };
  const seen = new Set<number>();
  const out: DynFieldData[] = [];
  for (const e of entries) {
    for (const f of toDynFields(e.fields, values, isEditableToStaff)) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      out.push(f);
    }
  }
  return out;
}

/** Converte il FormData dei campi dinamici (chiave = nome campo o id) in sorgente per i servizi. */
export function formSource(form: FormData, fields: { name: string; id: number; type: string }[], prefix = ""): Record<string, unknown> {
  const src: Record<string, unknown> = {};
  for (const f of fields) {
    const key = f.name || String(f.id);
    const v = form.get(prefix + key);
    if (f.type === "bool") src[key] = v ? "1" : "";
    else if (v !== null) src[key] = String(v);
  }
  return src;
}
