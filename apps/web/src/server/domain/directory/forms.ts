import "server-only";

import { sql } from "kysely";

import { NOW, table, type DbOrTx } from "../../db";
import { stripTags } from "../../format/html";
import { phpJsonDecode, phpJsonEncode } from "../../format/php-json";
import { htmlSearchable, sanitizeText, searchable, stripEmoticons } from "../../format/text";
import { phpLooseEquals } from "../ticket/record";

/**
 * Form dinamici (include/class.dynamic_forms.php, include/class.forms.php) per utenti (U),
 * organizzazioni (O) e task (A): righe form_entry / form_entry_values, tabelle *__cdata e testo
 * indicizzabile. Tipi di campo gestiti: text, memo, phone, bool, choices, datetime; gli altri tipi
 * sono trattati come testo semplice (nessun campo di questo tipo è definito nei form di default).
 */
export const FieldFlag = {
  ENABLED: 0x00001,
  EXT_STORED: 0x00002,
  CLOSE_REQUIRED: 0x00004,
  CLIENT_VIEW: 0x00100,
  CLIENT_EDIT: 0x00200,
  CLIENT_REQUIRED: 0x00400,
  AGENT_VIEW: 0x01000,
  AGENT_EDIT: 0x02000,
  AGENT_REQUIRED: 0x04000,
} as const;

export interface FieldDef {
  id: number;
  form_id: number;
  type: string;
  label: string;
  name: string;
  flags: number;
  sort: number;
  hint: string | null;
  config: Record<string, unknown>;
}

export type FormObjectType = "U" | "O" | "A";

/** Valore "PHP" di un campo dopo parse()/to_php(): stringa, booleano, scelte {chiave: etichetta} o null. */
export type FieldValue = string | boolean | Record<string, string> | null;

const NO_DATA = new Set(["break", "info"]);
const PRESENTATION_ONLY = new Set(["thread", "break", "info"]);

export const hasData = (f: FieldDef) => !NO_DATA.has(f.type);
export const isStorable = (f: FieldDef) => (f.flags & FieldFlag.EXT_STORED) === 0;
export const isEnabled = (f: FieldDef) => (f.flags & FieldFlag.ENABLED) !== 0;
export const isVisibleToStaff = (f: FieldDef) => isEnabled(f) && (f.flags & FieldFlag.AGENT_VIEW) !== 0;
export const isEditableToStaff = (f: FieldDef) => isEnabled(f) && (f.flags & FieldFlag.AGENT_EDIT) !== 0;
export const isRequiredForStaff = (f: FieldDef) => (f.flags & FieldFlag.AGENT_REQUIRED) !== 0;
/** Campo che ha una riga form_entry_values (DynamicFormEntry::create). */
export const hasAnswerRow = (f: FieldDef) => hasData(f) && isStorable(f) && !PRESENTATION_ONLY.has(f.type);

/** Configurazione con i default dei tipi usati (getConfigurationOptions). */
function configOf(type: string, raw: string | null): Record<string, unknown> {
  const parsed = phpJsonDecode<Record<string, unknown>>(raw, {}) ?? {};
  const defaults: Record<string, unknown> =
    type === "memo" ? { html: true } : type === "phone" ? { ext: true, digits: 7, format: "us" } : {};
  return { ...defaults, ...(typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}) };
}

export async function loadFormFields(executor: DbOrTx, formId: number): Promise<FieldDef[]> {
  const rows = await executor
    .selectFrom("form_field")
    .select(["id", "form_id", "type", "label", "name", "flags", "sort", "hint", "configuration"])
    .where("form_id", "=", formId)
    .orderBy("sort")
    .orderBy("id")
    .execute();
  return rows.map((r) => ({
    id: r.id,
    form_id: r.form_id,
    type: r.type ?? "text",
    label: r.label,
    name: r.name,
    flags: r.flags ?? 0,
    sort: r.sort,
    hint: r.hint,
    config: configOf(r.type ?? "text", r.configuration),
  }));
}

/** UserForm::getUserForm(), OrganizationForm::getDefaultForm(), TaskForm::getDefaultForm(). */
export async function defaultFormOf(executor: DbOrTx, type: FormObjectType): Promise<{ id: number; fields: FieldDef[] } | null> {
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

/** Scelte di un campo choices (configurazione "choices": righe "chiave:etichetta"). */
export function fieldChoices(f: FieldDef): Record<string, string> {
  const raw = f.config.choices;
  if (raw && typeof raw === "object") return raw as Record<string, string>;
  const out: Record<string, string> = {};
  for (const line of String(raw ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [k, ...rest] = line.split(":");
    out[k.trim()] = rest.length ? rest.join(":").trim() : k.trim();
  }
  return out;
}

/** FormField::parse() dell'input inviato dal form. `ext` è l'interno del telefono. */
export function parseInput(f: FieldDef, raw: unknown, ext?: string): FieldValue {
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

/** FormField::to_database() */
export function toDatabase(f: FieldDef, v: FieldValue): string | null {
  if (f.type === "bool") return v ? "1" : "0";
  if (v === null || v === undefined) return null;
  if (typeof v === "object") return phpJsonEncode(v);
  if (typeof v === "boolean") return v ? "1" : "";
  return v;
}

/** FormField::to_php() del valore memorizzato. */
export function toPhp(f: FieldDef, value: string | null): FieldValue {
  if (value === null) return f.type === "bool" ? false : null;
  if (f.type === "bool") return !!value && value !== "0";
  if (f.type === "choices") {
    const parsed = phpJsonDecode<Record<string, string> | null>(value, null);
    return parsed && typeof parsed === "object" ? parsed : value;
  }
  return value;
}

/** Format::phone */
export function formatPhone(phone: string): string {
  const stripped = phone.replace(/[^0-9]/g, "");
  if (stripped.length === 7) return `${stripped.slice(0, 3)}-${stripped.slice(3)}`;
  if (stripped.length === 10) return `(${stripped.slice(0, 3)}) ${stripped.slice(3, 6)}-${stripped.slice(6)}`;
  return phone;
}

/** FormField::toString() */
export function valueToString(f: FieldDef, v: FieldValue): string {
  if (f.type === "bool") return v ? "Yes" : "No";
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return Object.values(v).join(", ");
  const s = String(v);
  if (f.type === "phone") {
    const [phone, ext] = s.split("X", 2);
    let out = f.config.format === "us" ? formatPhone(phone) : phone;
    if (ext) out += ` x${ext}`;
    return out;
  }
  return s;
}

/** DynamicFormEntryAnswer::getSearchable(): testo indicizzato (_search) della risposta. */
export function answerSearchable(f: FieldDef, dbValue: string | null): string {
  const v = toPhp(f, dbValue);
  if (f.type === "memo") return htmlSearchable(typeof v === "string" ? v : "");
  return searchable(valueToString(f, v));
}

/** DynamicFormEntryAnswer::getSearchKeys(): valore scritto nella tabella *__cdata. */
export function answerSearchKeys(f: FieldDef, dbValue: string | null): string {
  const v = toPhp(f, dbValue);
  if (f.type === "choices") return v && typeof v === "object" ? Object.keys(v).join(", ") : String(v ?? "");
  const db = toDatabase(f, v);
  return db ?? "";
}

const CDATA: Record<string, { table: "user__cdata" | "organization__cdata" | "task__cdata" | "ticket__cdata"; key: string }> = {
  U: { table: "user__cdata", key: "user_id" },
  O: { table: "organization__cdata", key: "org_id" },
  A: { table: "task__cdata", key: "task_id" },
  T: { table: "ticket__cdata", key: "ticket_id" },
};

const cdataColumns = new Map<string, Set<string>>();

async function columnsOf(executor: DbOrTx, name: string): Promise<Set<string>> {
  let cols = cdataColumns.get(name);
  if (!cols) {
    const { rows } = await sql<{ Field: string }>`SHOW COLUMNS FROM ${table(name as "user__cdata")}`.execute(executor);
    cols = new Set(rows.map((r) => r.Field));
    cdataColumns.set(name, cols);
  }
  return cols;
}

/**
 * DynamicForm::updateDynamicDataView: INSERT … ON DUPLICATE KEY UPDATE della colonna del campo nella
 * tabella *__cdata (solo se la colonna esiste, come la query del PHP che altrimenti fallisce in silenzio).
 */
export async function updateCdata(executor: DbOrTx, formType: string, objectId: number, f: FieldDef, dbValue: string | null): Promise<void> {
  const c = CDATA[formType];
  if (!c) return;
  const col = f.name || `field_${f.id}`;
  if (!(await columnsOf(executor, c.table)).has(col)) return;
  const value = answerSearchKeys(f, dbValue);
  await sql`INSERT INTO ${table(c.table)} SET ${sql.ref(col)} = ${value}, ${sql.ref(c.key)} = ${objectId}
    ON DUPLICATE KEY UPDATE ${sql.ref(col)} = ${value}`.execute(executor);
}

export interface EntryAnswer {
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

/** Valore inviato per un campo: per nome o per id (come Widget::getValue con getFormNames). */
export function inputFor(input: Record<string, unknown>, f: FieldDef): unknown {
  if (f.name && f.name in input) return input[f.name];
  if (String(f.id) in input) return input[String(f.id)];
  return undefined;
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
  for (const f of form.fields) {
    if (!hasAnswerRow(f)) continue;
    const raw = inputFor(input, f);
    const clean = parseInput(f, raw, typeof input[`${f.name}-ext`] === "string" ? (input[`${f.name}-ext`] as string) : undefined);
    const db = toDatabase(f, clean);
    const value = phpLooseEquals(null, db) ? null : db;
    await executor.insertInto("form_entry_values").values({ entry_id: entryId, field_id: f.id, value }).execute();
    await updateCdata(executor, formType, objectId, f, value);
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
  for (const f of entry.fields) {
    if (!hasAnswerRow(f)) continue;
    if (opts.isEditable && !opts.isEditable(f)) continue;
    const raw = inputFor(input, f);
    if (opts.onlyProvided && raw === undefined) continue;
    const ans = entry.answers.get(f.id);
    const old = ans?.value ?? null;
    const clean = parseInput(f, raw, typeof input[`${f.name}-ext`] === "string" ? (input[`${f.name}-ext`] as string) : undefined);
    const db = toDatabase(f, clean);
    if (!ans?.exists) {
      // risposta mancante (campo aggiunto dopo la creazione): addMissingFields la crea vuota
      await executor.insertInto("form_entry_values").values({ entry_id: entry.id, field_id: f.id, value: null }).execute();
      await updateCdata(executor, entry.form_type, objectId, f, null);
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
    await updateCdata(executor, entry.form_type, objectId, f, db);
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
    const raw = inputFor(input, f);
    const clean = parseInput(f, raw);
    const empty = clean === null || clean === "" || clean === false;
    if (isRequiredForStaff(f) && empty) errors[f.name || String(f.id)] = "required";
    else if (!empty && f.config.validator === "email" && typeof clean === "string" && !isEmail(clean)) errors[f.name || String(f.id)] = "email";
    else if (!empty && f.type === "phone" && typeof clean === "string") {
      const [phone] = clean.split("X", 2);
      if (phone && (!/^\d+$/.test(phone) || phone.length < Number(f.config.digits ?? 7))) errors[f.name || String(f.id)] = "phone";
    }
  }
  return errors;
}

/** Validator::is_email (parser RFC 822 semplificato, senza verifica DNS). */
export function isEmail(v: string): boolean {
  return /^[^\s@<>(),;:"[\]]+@[^\s@<>(),;:"[\]]+\.[^\s@<>(),;:"[\]]+$/.test(v.trim()) && !/@localhost$/i.test(v.trim());
}

/**
 * Validator::is_valid_email: con config verify_email_addrs il dominio deve avere un record MX
 * (o, in mancanza, A/AAAA), come dns_get_record del PHP.
 */
export async function isValidEmail(v: string, verify: boolean): Promise<boolean> {
  if (!isEmail(v)) return false;
  if (!verify) return true;
  const host = v.trim().split("@").pop() ?? "";
  const { resolveMx, resolve4, resolve6 } = await import("node:dns/promises");
  try {
    if ((await resolveMx(`${host}.`)).length) return true;
  } catch {
    /* nessun MX: si prova A/AAAA */
  }
  for (const fn of [resolve4, resolve6]) {
    try {
      if ((await fn(`${host}.`)).length) return true;
    } catch {
      /* nessun record */
    }
  }
  return false;
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
