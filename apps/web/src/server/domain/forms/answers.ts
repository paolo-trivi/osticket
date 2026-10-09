import "server-only";

import { sql } from "kysely";

import { loadConfigNamespace } from "../../config/config";
import { NOW, type DbOrTx } from "../../db";
import { stripTags } from "../../format/html";
import { phpJsonDecode } from "../../format/php-json";
import { sanitizeText, stripEmoticons } from "../../format/text";
import { phpLooseEquals } from "../ticket/record";
import { cdataColumns, upsertCdata } from "./cdata";
import {
  cleanFromDb,
  fieldChoices,
  fieldSearchKeys,
  fieldSearchable,
  fieldToDatabase,
  hasAnswerRow,
  hasData,
  isRequiredForStaff,
  isVisibleToStaff,
  type CleanValue,
  type FieldDef,
} from "./fields";
import { loadFormDef } from "./load";
import { isEmail, isValidEmail, phpIsNumeric } from "./validator";

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
    .where(sql<boolean>`(flags & 2) = 0`)
    .orderBy("id")
    .executeTakeFirst();
  if (!form) return null;
  return { id: form.id, fields: await loadFormFields(executor, form.id) };
}

/** Valore inviato per un campo: per nome o per id (come Widget::getValue con getFormNames). */
export function inputFor(input: Record<string, unknown>, f: FieldDef): unknown {
  if (f.name && f.name in input) return input[f.name];
  if (String(f.id) in input) return input[String(f.id)];
  return undefined;
}

/**
 * FormField::parse dell'input per le risposte di utenti, organizzazioni, task e azienda. `ext` è
 * l'interno del telefono. Rispetto a parseField (ticket, portale) un campo assente vale "" per testo
 * e memo, "false" è falso per bool, una scelta sconosciuta resta testo e gli altri tipi (data,
 * liste, file) sono trattati come testo semplice.
 */
export function parseInput(f: FieldDef, raw: unknown, ext?: string): CleanValue {
  const str = raw === null || raw === undefined ? null : typeof raw === "string" ? raw : String(raw);
  switch (f.type) {
    case "bool":
      return !!raw && raw !== "0" && raw !== "false";
    case "memo":
      if (str === null) return "";
      return f.config.html ? sanitizeText(str) : str;
    case "phone": {
      let base = str;
      if (base === null) return null;
      if (ext) base += `X${ext}`;
      const val = base.replace(/[^\dX]/g, "");
      return val || base;
    }
    case "choices": {
      if (!str) return null;
      const choices = fieldChoices(f);
      if (str in choices) return { [str]: choices[str] };
      const parsed = phpJsonDecode<Record<string, string> | null>(str, null);
      return parsed && typeof parsed === "object" ? parsed : str;
    }
    case "datetime":
      return str;
    default:
      // TextboxField::parse: Format::strip_emoticons(Format::striptags($value))
      return stripEmoticons(stripTags(str ?? ""));
  }
}

/** FormField::to_database() (valore di form_entry_values.value) */
export function toDatabase(f: FieldDef, v: CleanValue): string | null {
  return fieldToDatabase(f, v).value;
}

/** DynamicFormEntryAnswer::getSearchable(): testo indicizzato (_search) della risposta. */
export function answerSearchable(f: FieldDef, dbValue: string | null): string {
  return fieldSearchable(f, cleanFromDb(f, dbValue, null)) ?? "";
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

function extOf(input: Record<string, unknown>, f: FieldDef): string | undefined {
  const ext = input[`${f.name}-ext`];
  return typeof ext === "string" ? ext : undefined;
}

/**
 * DynamicForm::instanciate + DynamicFormEntry::save: nuova riga form_entry con le risposte dei campi
 * memorizzabili. Le risposte "vuote" (uguali a NULL per il confronto debole PHP) non sono marcate
 * modificate e restano NULL. Ogni risposta inserita aggiorna la tabella *__cdata.
 */
export async function createEntry(
  executor: DbOrTx,
  form: { id: number; fields: FieldDef[] },
  formType: string,
  objectType: string,
  objectId: number,
  input: Record<string, unknown>,
  sort = 1,
): Promise<number> {
  const res = await executor
    .insertInto("form_entry")
    .values({ form_id: form.id, object_type: objectType, object_id: objectId, sort, created: NOW, updated: NOW })
    .executeTakeFirstOrThrow();
  const entryId = Number(res.insertId);
  const columns = await cdataColumns(executor, formType);
  for (const f of form.fields) {
    if (!hasAnswerRow(f)) continue;
    const db = toDatabase(f, parseInput(f, inputFor(input, f), extOf(input, f)));
    const value = phpLooseEquals(null, db) ? null : db;
    await executor.insertInto("form_entry_values").values({ entry_id: entryId, field_id: f.id, value }).execute();
    await upsertCdata(executor, formType, objectId, f, answerSearchKeys(f, value), columns);
  }
  return entryId;
}

/**
 * DynamicFormEntry::saveAnswers($isEditable): aggiorna le risposte modificate (confronto debole PHP).
 * Restituisce il numero di risposte modificate e le modifiche [vecchio, nuovo] per id campo.
 * `onlyProvided`: considera solo i campi presenti nell'input (modifica di un singolo campo).
 */
export async function saveEntryAnswers(
  executor: DbOrTx,
  entry: FormEntry,
  objectId: number,
  input: Record<string, unknown>,
  opts: { isEditable?: (f: FieldDef) => boolean; onlyProvided?: boolean } = {},
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
    const raw = inputFor(input, f);
    if (opts.onlyProvided && raw === undefined) continue;
    const ans = entry.answers.get(f.id);
    const old = ans?.value ?? null;
    const db = toDatabase(f, parseInput(f, raw, extOf(input, f)));
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

/** Testo indicizzabile delle risposte (MysqlSearchBackend per User/Organization). */
export function entriesSearchable(entries: FormEntry[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    for (const f of e.fields) {
      const a = e.answers.get(f.id);
      if (!a?.exists) continue;
      if (f.name === "subject") continue;
      const s = answerSearchable(f, a.value);
      if (s) out.push(s);
    }
  }
  return out;
}

/** Validazione minima lato agente: campi obbligatori e formato email/telefono. */
export function validateInput(fields: FieldDef[], input: Record<string, unknown>, filter: (f: FieldDef) => boolean): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of fields) {
    if (!hasData(f) || !filter(f) || !isVisibleToStaff(f)) continue;
    const clean = parseInput(f, inputFor(input, f));
    const empty = clean === null || clean === "" || clean === false;
    const key = f.name || String(f.id);
    if (isRequiredForStaff(f) && empty) errors[key] = "required";
    else if (!empty && f.config.validator === "email" && typeof clean === "string" && !isEmail(clean)) errors[key] = "email";
    else if (!empty && f.type === "phone" && typeof clean === "string") {
      const [phone] = clean.split("X", 2);
      if (phone && (!phpIsNumeric(phone) || phone.length < Number(f.config.digits ?? 7))) errors[key] = "phone";
    }
  }
  return errors;
}

/** Errori "email" aggiuntivi della verifica DNS per i campi con validatore email. */
export async function verifyEmailFields(fields: FieldDef[], input: Record<string, unknown>, verify: boolean, filter: (f: FieldDef) => boolean): Promise<Record<string, string>> {
  const errors: Record<string, string> = {};
  if (!verify) return errors;
  for (const f of fields) {
    if (f.config.validator !== "email" || !filter(f)) continue;
    const v = parseInput(f, inputFor(input, f));
    if (typeof v === "string" && v && !(await isValidEmail(v, true))) errors[f.name || String(f.id)] = "email";
  }
  return errors;
}
