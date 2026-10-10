import "server-only";

import { sql } from "kysely";

import { DynamicForm, DynamicFormField } from "@/lib/osticket/flags";

import { loadConfigNamespace, type ConfigNamespace } from "../../config/config";
import type { DbOrTx } from "../../db";
import { phpLooseEquals } from "../../php/values";
import { cdataColumns, upsertCdata } from "./cdata";
import { FormInstance, saveFormEntry } from "./entry";
import {
  cleanFromDb,
  fieldSearchKeys,
  fieldSearchable,
  fieldToDatabase,
  hasAnswerRow,
  hasData,
  inSource,
  isRequiredForStaff,
  isVisibleToStaff,
  parseField,
  validateField,
  type CleanValue,
  type DateFormatOptions,
  type FieldDef,
  type FieldErrorCode,
} from "./fields";
import { loadFormDef } from "./load";

/**
 * Entry dei form dinamici di oggetti esistenti (include/class.dynamic_forms.php): utenti (U),
 * organizzazioni (O), task (A) e azienda (C). Lettura delle entry con le risposte, nuova entry
 * (DynamicForm::instanciate + save), modifica delle risposte (saveAnswers), eliminazione, testo
 * indicizzabile e validazione lato agente. Campi, conversioni e cdata sono quelli comuni di
 * ./fields e ./cdata.
 */

/** Campi di un form ordinati per `sort`, con configurazione e scelte risolte. */
export async function loadFormFields(executor: DbOrTx, formId: number): Promise<FieldDef[]> {
  const cfg = await loadConfigNamespace("core", executor);
  return (await loadFormDef(executor, cfg, { id: formId }))?.fields ?? [];
}

/** UserForm::getUserForm(), OrganizationForm::getDefaultForm(), TaskForm::getDefaultForm(). */
export async function defaultFormOf(executor: DbOrTx, type: "U" | "O" | "A"): Promise<{ id: number; fields: FieldDef[] } | null> {
  const form = await executor
    .selectFrom("form")
    .select("id")
    .where("type", "=", type)
    .where(sql<boolean>`(flags & ${sql.lit(DynamicForm.DELETED)}) = 0`)
    .orderBy("id")
    .executeTakeFirst();
  if (!form) return null;
  return { id: form.id, fields: await loadFormFields(executor, form.id) };
}

/** Opzioni di lettura dell'input: fuso dell'utente corrente per i campi data ($cfg->getTimezone()). */
interface ParseOptions {
  timezone?: string;
}

/** FormField::to_database() (valore di form_entry_values.value) */
export function toDatabase(f: FieldDef, v: CleanValue): string | null {
  return fieldToDatabase(f, v).value;
}

/** DynamicFormEntryAnswer::getSearchable(): testo indicizzato (_search) della risposta (date con Format::date). */
function answerSearchable(f: FieldDef, dbValue: string | null, dates?: DateFormatOptions): string {
  return fieldSearchable(f, cleanFromDb(f, dbValue, null), dates) ?? "";
}

/** Formati delle date per l'indice quando manca l'utente corrente: config core e fuso predefinito. */
export async function defaultDates(executor: DbOrTx): Promise<DateFormatOptions> {
  const cfg = await loadConfigNamespace("core", executor);
  return { cfg, timezone: cfg.str("default_timezone") || "UTC" };
}

/** DynamicFormEntryAnswer::getSearchKeys(): valore scritto nella tabella *__cdata. */
function answerSearchKeys(f: FieldDef, dbValue: string | null): string {
  return fieldSearchKeys(f, cleanFromDb(f, dbValue, null));
}

interface EntryAnswer {
  field: FieldDef;
  value: string | null;
  exists: boolean;
}

export interface FormEntry {
  id: number;
  form_id: number;
  form_type: string;
  sort: number;
  fields: FieldDef[];
  answers: Map<number, EntryAnswer>;
}

/** DynamicFormEntry::forObject($id, $type) con campi e risposte. */
export async function entriesFor(executor: DbOrTx, objectType: string, objectId: number): Promise<FormEntry[]> {
  const entries = await executor
    .selectFrom("form_entry as e")
    .innerJoin("form as f", "f.id", "e.form_id")
    .select(["e.id", "e.form_id", "e.sort", "f.type as form_type"])
    .where("e.object_type", "=", objectType)
    .where("e.object_id", "=", objectId)
    .orderBy("e.sort")
    .orderBy("e.id")
    .execute();
  const out: FormEntry[] = [];
  for (const e of entries) {
    const fields = await loadFormFields(executor, e.form_id);
    const vals = await executor.selectFrom("form_entry_values").select(["field_id", "value"]).where("entry_id", "=", e.id).execute();
    const byField = new Map(vals.map((v) => [v.field_id, v.value]));
    const answers = new Map<number, EntryAnswer>();
    for (const f of fields) answers.set(f.id, { field: f, value: byField.get(f.id) ?? null, exists: byField.has(f.id) });
    out.push({ id: e.id, form_id: e.form_id, form_type: e.form_type ?? "", sort: e.sort, fields, answers });
  }
  return out;
}

/**
 * DynamicForm::instanciate + DynamicFormEntry::save: nuova riga form_entry con le risposte dei campi
 * memorizzabili lette dalla sorgente (stesso motore di ticket e portale: FormInstance + saveFormEntry,
 * con le risposte "vuote" che restano NULL e l'aggiornamento della tabella *__cdata).
 */
export async function createEntry(
  executor: DbOrTx,
  form: { id: number; fields: FieldDef[] },
  formType: string,
  objectType: "U" | "O" | "A",
  objectId: number,
  input: Record<string, unknown>,
  opts: ParseOptions & { sort?: number } = {},
): Promise<number> {
  const def = { id: form.id, type: formType, title: "", instructions: "", fields: form.fields };
  const inst = new FormInstance(def, input, opts.sort ?? 1, null, { timezone: opts.timezone });
  return saveFormEntry(executor, inst, objectType, objectId);
}

/**
 * DynamicFormEntry::addMissingFields (User::getForms, Organization::getForms, prima della validazione):
 * risposta NULL per i campi attivi e memorizzabili aggiunti al form dopo la creazione dell'entry, con
 * l'aggiornamento della tabella *__cdata.
 */
export async function addMissingAnswers(executor: DbOrTx, entry: FormEntry, objectId: number): Promise<void> {
  let columns: Set<string> | null | undefined;
  for (const f of entry.fields) {
    const ans = entry.answers.get(f.id);
    if (ans?.exists || !hasAnswerRow(f) || !(f.flags & DynamicFormField.ENABLED)) continue;
    await executor.insertInto("form_entry_values").values({ entry_id: entry.id, field_id: f.id, value: null }).execute();
    if (columns === undefined) columns = await cdataColumns(executor, entry.form_type);
    await upsertCdata(executor, entry.form_type, objectId, f, answerSearchKeys(f, null), columns);
    if (ans) ans.exists = true;
  }
}

/**
 * DynamicFormEntry::saveAnswers($isEditable): aggiorna le risposte modificate (confronto debole PHP).
 * Restituisce il numero di risposte modificate e le modifiche [vecchio, nuovo] per id campo.
 * `onlyProvided`: considera solo i campi presenti nell'input (Widget::parseValue: un campo assente
 * dalla sorgente riprende la risposta attuale).
 */
export async function saveEntryAnswers(
  executor: DbOrTx,
  entry: FormEntry,
  objectId: number,
  input: Record<string, unknown>,
  opts: ParseOptions & { isEditable?: (f: FieldDef) => boolean; onlyProvided?: boolean } = {},
): Promise<{ dirty: number; changes: Record<number, [string | null, string | null]> }> {
  let dirty = 0;
  const changes: Record<number, [string | null, string | null]> = {};
  let columns: Set<string> | null | undefined;
  const cdata = async (f: FieldDef, value: string | null) => {
    if (columns === undefined) columns = await cdataColumns(executor, entry.form_type);
    await upsertCdata(executor, entry.form_type, objectId, f, answerSearchKeys(f, value), columns);
  };
  for (const f of entry.fields) {
    if (!hasAnswerRow(f)) continue;
    if (opts.isEditable && !opts.isEditable(f)) continue;
    if (opts.onlyProvided && !inSource(f, input)) continue;
    const ans = entry.answers.get(f.id);
    const old = ans?.value ?? null;
    const db = toDatabase(f, parseField(f, input, opts.timezone));
    if (!ans?.exists) {
      // risposta mancante (campo aggiunto dopo la creazione): addMissingFields la crea vuota
      await executor.insertInto("form_entry_values").values({ entry_id: entry.id, field_id: f.id, value: null }).execute();
      await cdata(f, null);
      if (ans) ans.exists = true;
    }
    if (phpLooseEquals(old, db)) continue;
    dirty++;
    changes[f.id] = [old, db];
    await executor
      .updateTable("form_entry_values")
      .set({ value: db })
      .where("entry_id", "=", entry.id)
      .where("field_id", "=", f.id)
      .execute();
    if (ans) ans.value = db;
    await cdata(f, db);
  }
  return { dirty, changes };
}

/** DynamicFormEntry::delete: entry e risposte (le righe *__cdata restano, come nel PHP). */
export async function deleteEntries(executor: DbOrTx, objectType: string, objectId: number): Promise<void> {
  const entries = await executor.selectFrom("form_entry").select("id").where("object_type", "=", objectType).where("object_id", "=", objectId).execute();
  for (const e of entries) {
    await executor.deleteFrom("form_entry").where("id", "=", e.id).execute();
    await executor.deleteFrom("form_entry_values").where("entry_id", "=", e.id).execute();
  }
}

/**
 * Testo indicizzabile delle risposte (MysqlSearchBackend per User/Organization): `skip` sono i campi
 * esclusi per nome (`subject` per gli utenti).
 */
export function entriesSearchable(entries: FormEntry[], dates?: DateFormatOptions, skip: string[] = []): string[] {
  const out: string[] = [];
  for (const e of entries) {
    for (const f of e.fields) {
      const a = e.answers.get(f.id);
      if (!a?.exists) continue;
      if (skip.includes(f.name)) continue;
      const s = answerSearchable(f, a.value, dates);
      if (s) out.push(s);
    }
  }
  return out;
}

/**
 * Form::isValid lato agente sui campi con dati per cui `filter` è vero e visibili all'agente: stessi
 * validatori di ticket e portale (FormField::validateEntry, con la verifica DNS delle email se
 * `verify_email_addrs`). Restituisce il primo codice d'errore per nome (o id) del campo.
 */
export async function validateInput(
  fields: FieldDef[],
  input: Record<string, unknown>,
  filter: (f: FieldDef) => boolean,
  cfg: ConfigNamespace,
  opts: ParseOptions = {},
): Promise<Record<string, FieldErrorCode>> {
  const errors: Record<string, FieldErrorCode> = {};
  for (const f of fields) {
    if (!hasData(f) || !filter(f) || !isVisibleToStaff(f)) continue;
    const codes = await validateField(f, parseField(f, input, opts.timezone), isRequiredForStaff(f), cfg);
    if (codes.length) errors[f.name || String(f.id)] = codes[0];
  }
  return errors;
}
