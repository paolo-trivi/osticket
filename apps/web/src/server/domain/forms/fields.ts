import "server-only";

import { promises as dns } from "node:dns";

import { DateTime } from "luxon";

import type { ConfigNamespace } from "../../config/config";
import { htmlChars, phpStripTags, stripTags } from "../../format/html";
import { phpJsonDecode, phpJsonEncode } from "../../format/php-json";
import { htmlSearchable, sanitizeText, searchable, stripEmoticons } from "../../format/text";

/**
 * Campi dei form dinamici (include/class.forms.php + class.dynamic_forms.php): flag di visibilità,
 * configurazione con i default del tipo, parse dell'input, validazione, conversione verso il DB
 * (`form_entry_values.value` / `value_id`), testo per filtri, indice e cdata.
 */

/** DynamicFormField::FLAG_* */
export const FieldFlag = {
  ENABLED: 0x00001,
  EXT_STORED: 0x00002,
  CLOSE_REQUIRED: 0x00004,
  MASK_CHANGE: 0x00010,
  MASK_DELETE: 0x00020,
  MASK_EDIT: 0x00040,
  MASK_DISABLE: 0x00080,
  CLIENT_VIEW: 0x00100,
  CLIENT_EDIT: 0x00200,
  CLIENT_REQUIRED: 0x00400,
  AGENT_VIEW: 0x01000,
  AGENT_EDIT: 0x02000,
  AGENT_REQUIRED: 0x04000,
  MASK_REQUIRE: 0x10000,
  MASK_VIEW: 0x20000,
  MASK_NAME: 0x40000,
} as const;

/** Contesto di compilazione: agente (staff) o cliente (web). */
export type FormAudience = "staff" | "client";

export interface FieldDef {
  id: number;
  formId: number;
  type: string;
  label: string;
  name: string;
  hint: string;
  flags: number;
  sort: number;
  /** configurazione salvata + default del tipo (FormField::getConfiguration) */
  config: Record<string, unknown>;
  /** campo disattivato dall'help topic (help_topic_form.extra.disable) */
  disabled?: boolean;
  /** scelte risolte (choices, priorità, reparti, liste) */
  choices?: Record<string, string>;
}

export function hasFlag(f: Pick<FieldDef, "flags">, flag: number): boolean {
  return (f.flags & flag) !== 0;
}
function isEnabled(f: FieldDef): boolean {
  return !f.disabled && hasFlag(f, FieldFlag.ENABLED);
}
export function isVisibleTo(f: FieldDef, who: FormAudience): boolean {
  return isEnabled(f) && hasFlag(f, who === "staff" ? FieldFlag.AGENT_VIEW : FieldFlag.CLIENT_VIEW);
}
export function isEditableTo(f: FieldDef, who: FormAudience): boolean {
  return isEnabled(f) && hasFlag(f, who === "staff" ? FieldFlag.AGENT_EDIT : FieldFlag.CLIENT_EDIT);
}
export function isRequiredFor(f: FieldDef, who: FormAudience): boolean {
  return hasFlag(f, who === "staff" ? FieldFlag.AGENT_REQUIRED : FieldFlag.CLIENT_REQUIRED);
}
/** FormField::hasData: niente dati per separatori e testo informativo */
export function hasData(f: FieldDef): boolean {
  return f.type !== "break" && f.type !== "info";
}
/** FormField::isStorable */
export function isStorable(f: FieldDef): boolean {
  return (f.flags & FieldFlag.EXT_STORED) === 0;
}
/** ThreadEntryField è "presentation only": il corpo diventa il primo messaggio */
export function isPresentationOnly(f: FieldDef): boolean {
  return f.type === "thread";
}

/** Default di getConfigurationOptions() per tipo. */
function typeDefaults(type: string, cfg: ConfigNamespace): Record<string, unknown> {
  switch (type) {
    case "text":
      return { size: 16, length: 30, validator: "", regex: undefined, "validator-error": "", placeholder: "" };
    case "memo":
      return { cols: 40, rows: 4, length: 0, html: true, placeholder: "" };
    case "phone":
      return { ext: true, digits: 7, format: "us" };
    case "bool":
      return { desc: undefined };
    case "choices":
      return { choices: "", default: "", prompt: "", multiselect: false };
    case "datetime":
      return { time: false, timezone: undefined, gmt: undefined, min: undefined, max: null, future: true };
    case "priority":
      return { prompt: "", default: cfg.int("default_priority_id") || "" };
    case "department":
    case "timezone":
      return { prompt: "" };
    case "files":
      return { size: cfg.int("max_file_size"), mimetypes: undefined, extensions: undefined, strictmimecheck: false, max: false };
    case "thread":
      return {
        attachments: cfg.bool("allow_attachments"),
        size: cfg.int("max_file_size"),
        mimetypes: undefined,
        extensions: cfg.str("allowed_filetypes").trim() || undefined,
        strictmimecheck: false,
        max: false,
      };
    default:
      if (type.startsWith("list-")) return { multiselect: false, widget: "dropdown", validator: "", prompt: "", default: "" };
      return {};
  }
}

export function fieldConfig(type: string, raw: string | null, cfg: ConfigNamespace): Record<string, unknown> {
  const saved = phpJsonDecode<Record<string, unknown> | null>(raw, null) ?? {};
  const out: Record<string, unknown> = { ...(Array.isArray(saved) ? {} : saved) };
  for (const [k, v] of Object.entries(typeDefaults(type, cfg))) if (out[k] === undefined || out[k] === null) out[k] = v;
  // ThreadEntryField::getConfiguration: html = rich text di sistema
  if (type === "thread") out.html = cfg.bool("enable_richtext");
  return out;
}

const truthy = (v: unknown) => !(v === undefined || v === null || v === false || v === "" || v === "0" || v === 0);

/**
 * Valore "pulito" di un campo (getClean):
 * - testo, memo, telefono, data, fuso: stringa o null;
 * - bool: boolean;
 * - choices, liste, file: oggetto chiave → etichetta;
 * - priorità e reparto: {id, label}.
 */
export type CleanValue = string | boolean | null | Record<string, string> | { id: number; label: string };

export function isIdValue(v: CleanValue): v is { id: number; label: string } {
  return !!v && typeof v === "object" && "id" in v && "label" in v && typeof (v as { id: unknown }).id === "number";
}

/** ChoiceField::getChoices per il tipo choices (righe key:value) */
export function parseChoiceLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of String(text ?? "").split("\n")) {
    const idx = line.indexOf(":");
    const key = (idx >= 0 ? line.slice(0, idx) : line).trim();
    const val = idx >= 0 ? line.slice(idx + 1).trim() : key;
    out[key] = val === "" && idx < 0 ? key : val || key;
  }
  return out;
}

/** Abbreviazioni di fuso riconosciute da strtotime/new DateTime (offset in minuti) */
const TZ_ABBR: Record<string, number> = {
  UTC: 0, GMT: 0, Z: 0, WET: 0, WEST: 60, BST: 60, CET: 60, CEST: 120, EET: 120, EEST: 180, MSK: 180,
  EST: -300, EDT: -240, CST: -360, CDT: -300, MST: -420, MDT: -360, PST: -480, PDT: -420, IST: 330, JST: 540,
};

/**
 * Format::parseDateTime / new DateTime($value): un valore senza fuso è letto nel fuso predefinito del
 * PHP (bootstrap.php: UTC); offset espliciti e abbreviazioni (CEST, EST…) sono rispettati.
 */
export function phpParseDateTime(value: string): DateTime | null {
  const v = String(value ?? "").trim();
  if (!v) return null;
  if (/^\d+$/.test(v)) return DateTime.fromSeconds(Number(v), { zone: "UTC" });
  let base = v;
  let zone = "UTC";
  const abbr = /^(.*\d)\s+([A-Za-z]{1,5}|[+-]\d{2}(?::?\d{2})?)$/.exec(v);
  if (abbr) {
    const z = abbr[2].toUpperCase();
    if (z in TZ_ABBR) {
      const m = TZ_ABBR[z];
      zone = m === 0 ? "UTC" : `UTC${m > 0 ? "+" : "-"}${Math.floor(Math.abs(m) / 60)}${Math.abs(m) % 60 ? `:${String(Math.abs(m) % 60).padStart(2, "0")}` : ""}`;
      base = abbr[1];
    } else if (/^[+-]\d/.test(z)) {
      const mm = /^([+-])(\d{2}):?(\d{2})?$/.exec(z)!;
      zone = `UTC${mm[1]}${Number(mm[2])}${mm[3] && mm[3] !== "00" ? `:${mm[3]}` : ""}`;
      base = abbr[1];
    }
  }
  const opts = { zone, setZone: true };
  for (const dt of [
    DateTime.fromISO(base, opts),
    DateTime.fromSQL(base, opts),
    DateTime.fromFormat(base, "M/d/yyyy", opts),
    DateTime.fromFormat(base, "M/d/yyyy H:mm", opts),
    DateTime.fromFormat(base, "M/d/yyyy h:mm a", opts),
    DateTime.fromFormat(base, "M/d/yy", opts),
  ]) {
    if (dt.isValid) return dt;
  }
  return null;
}

/** DateTime::format('T') del PHP: abbreviazione del fuso (CEST, EST…) o offset "+03" / "+0530". */
function phpTzAbbr(dt: DateTime): string {
  if (dt.zoneName === "UTC" || dt.zoneName === "Etc/UTC") return "UTC";
  const name = (locale: string) =>
    new Intl.DateTimeFormat(locale, { timeZone: dt.zoneName ?? "UTC", timeZoneName: "short" }).formatToParts(dt.toJSDate()).find((p) => p.type === "timeZoneName")?.value ?? "";
  for (const locale of ["en-GB", "en-US"]) {
    const n = name(locale);
    if (n && !/^(GMT|UTC)[+-−]/.test(n)) return n;
  }
  const off = dt.offset;
  const h = String(Math.floor(Math.abs(off) / 60)).padStart(2, "0");
  const m = Math.abs(off) % 60;
  return `${off < 0 ? "-" : "+"}${h}${m ? String(m).padStart(2, "0") : ""}`;
}

/** Opzioni di formattazione delle date come Format::date/datetime (formati ICU della config core) */
export interface DateFormatOptions {
  cfg: ConfigNamespace;
  /** fuso dell'utente corrente ($cfg->getTimezone()) */
  timezone: string;
}

/** Format::date / Format::datetime: pattern personalizzato (date_formats = custom) o formato breve ICU della lingua */
function phpFormatDate(dt: DateTime, o: DateFormatOptions, withTime = false): string {
  const z = dt.setZone(o.timezone || "UTC");
  if (o.cfg.str("date_formats") === "custom") return z.setLocale("en-US").toFormat(o.cfg.str(withTime ? "datetime_format" : "date_format") || "MM/dd/y");
  const locale = (o.cfg.str("system_language") || "en_US").replace("_", "-");
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeZone: z.zoneName ?? "UTC" }).format(z.toJSDate());
  if (!withTime) return date;
  const time = new Intl.DateTimeFormat(locale, { timeStyle: "short", timeZone: z.zoneName ?? "UTC" }).format(z.toJSDate());
  return `${date} ${time}`.replace(/\u202f/g, " ");
}

/** Sorgente dei valori (POST/vars): per nome del campo o per id, come Widget::getValue. */
export type FormSource = Record<string, unknown>;

function rawValue(f: FieldDef, source: FormSource): unknown {
  if (f.name && source[f.name] !== undefined) return source[f.name];
  if (source[String(f.id)] !== undefined) return source[String(f.id)];
  return undefined;
}

/**
 * Widget::getValue + FormField::parse per tipo. `timezone` è il fuso dell'utente corrente
 * ($cfg->getTimezone()) usato da DatetimePickerWidget.
 */
export function parseField(f: FieldDef, source: FormSource, timezone = "UTC"): CleanValue {
  const raw = rawValue(f, source);
  switch (f.type) {
    case "text": {
      if (raw === undefined || raw === null) return null;
      // Format::strip_emoticons(Format::striptags($value))
      return stripEmoticons(stripTags(String(raw)));
    }
    case "memo": {
      // TextareaField::parse: nessun trim (solo Format::sanitize se HTML)
      if (raw === undefined || raw === null) return null;
      const v = String(raw);
      return f.config.html ? sanitizeText(v) : v;
    }
    case "phone": {
      if (raw === undefined || raw === null) return null;
      const name = f.name || String(f.id);
      const ext = source[`${name}-ext`];
      const base = String(raw).trim() + (truthy(ext) ? `X${String(ext)}` : "");
      const val = base.replace(/[^\dX]/g, "");
      return val || base;
    }
    case "bool":
      return truthy(raw);
    case "choices": {
      const choices = f.choices ?? parseChoiceLines(String(f.config.choices ?? ""));
      const values = Array.isArray(raw) ? raw.map(String) : truthy(raw) ? [String(raw)] : [];
      const out: Record<string, string> = {};
      for (const v of values) if (v in choices) out[v] = choices[v];
      return Object.keys(out).length ? out : null;
    }
    case "priority":
    case "department": {
      const id = Array.isArray(raw) ? Number(raw[0]) : Number(raw);
      if (!raw || !Number.isFinite(id) || !f.choices || !(String(id) in f.choices)) return null;
      return { id, label: f.choices[String(id)] };
    }
    case "datetime": {
      // DatetimePickerWidget::getValue: data letta in UTC, portata nel fuso del campo/utente,
      // salvata come 'Y-m-d H:i:s T' (es. "2026-09-30 02:00:00 CEST"); valore non interpretabile invariato
      if (raw === undefined || raw === null) return null;
      const v = String(raw);
      if (!v) return "";
      const dt = phpParseDateTime(v);
      if (!dt) return v.trim();
      const z = dt.setZone(String(f.config.timezone || timezone || "UTC"));
      return `${z.toFormat("yyyy-MM-dd HH:mm:ss")} ${phpTzAbbr(z)}`;
    }
    case "timezone":
      return raw === undefined || raw === null || raw === "" ? null : String(raw).trim();
    case "files": {
      // valori "id,nome" (POST) o {id: nome}
      const out: Record<string, string> = {};
      const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.entries(raw as Record<string, string>).map(([k, v]) => `${k},${v}`) : [];
      for (const item of list) {
        const [id, ...rest] = String(item).split(",");
        if (id) out[id] = rest.join(",");
      }
      return Object.keys(out).length ? out : null;
    }
    default: {
      if (f.type.startsWith("list-")) {
        const choices = f.choices ?? {};
        const values = Array.isArray(raw) ? raw.map(String) : truthy(raw) ? [String(raw)] : [];
        const out: Record<string, string> = {};
        for (const v of values) if (v in choices) out[v] = choices[v];
        return Object.keys(out).length ? out : null;
      }
      if (raw === undefined || raw === null) return null;
      return typeof raw === "string" ? raw.trim() : String(raw);
    }
  }
}

/** Validator::is_formula */
function isFormula(text: string): boolean {
  return /(^[^=+@-][\s\S]*$)|(^\+\d+$)/.test(text);
}

/** Validator::is_email (Mail_RFC822): un solo indirizzo, mailbox presente, host diverso da localhost. */
export function isEmail(email: string): boolean {
  const m = /^\s*(?:"[^"]*"|[^\s@<>(),;:"[\]]+)@([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*|\[[0-9.]+\])\s*$/.exec(email ?? "");
  if (!m) return false;
  return m[1].toLowerCase() !== "localhost";
}

/** Validator::is_valid_email con verify_email_addrs: record MX, altrimenti A/AAAA del dominio. */
async function isValidEmail(email: string, cfg: ConfigNamespace): Promise<boolean> {
  if (!isEmail(email)) return false;
  if (!cfg.bool("verify_email_addrs")) return true;
  const host = email.trim().split("@").pop()!.replace(/^\[|\]$/g, "");
  try {
    const mx = await dns.resolveMx(`${host}.`);
    if (mx.length) return true;
  } catch {
    /* nessun MX */
  }
  let n = 0;
  for (const fn of [dns.resolve4, dns.resolve6]) {
    try {
      n += (await fn(`${host}.`)).length;
    } catch {
      /* nessun record */
    }
  }
  return n > 0;
}

function phpIsNumeric(v: string): boolean {
  return /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(v);
}

/** Validator::is_phone */
function isPhone(v: string): boolean {
  const stripped = v.replace(/\(|\)|-|\.|\+|[  ]+/g, "");
  return phpIsNumeric(stripped) && stripped.length >= 7 && stripped.length <= 16;
}

/** Messaggi di errore dei validatori (testo inglese del PHP, tradotto dalla UI tramite il codice). */
export type FieldErrorCode = "required" | "email" | "phone" | "ip" | "number" | "regex" | "formula" | "phone_ext" | "phone_ext_missing" | "files_max" | "date_past";

/**
 * FormField::validateEntry per tipo. `required` è già risolto per il contesto ($thisstaff ?
 * obbligatorio per agenti : per clienti). Restituisce i codici d'errore.
 */
export async function validateField(f: FieldDef, value: CleanValue, required: boolean, cfg: ConfigNamespace): Promise<FieldErrorCode[]> {
  const errors: FieldErrorCode[] = [];
  const empty =
    value === null || value === false || value === "" || (typeof value === "object" && !isIdValue(value) && !Object.keys(value).length);
  if (required && empty && hasData(f)) errors.push("required");
  if (empty) return errors;
  switch (f.type) {
    case "text": {
      const v = value === "0" ? "&#48" : htmlChars(String(value));
      let validator = String(f.config.validator ?? "");
      if (!validator) validator = "formula";
      if (validator === "email" && !(await isValidEmail(v, cfg))) errors.push("email");
      else if (validator === "phone" && !isPhone(v)) errors.push("phone");
      else if (validator === "ip" && !/^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]+$/i.test(v.trim())) errors.push("ip");
      else if (validator === "number" && !phpIsNumeric(v === "&#48" ? "0" : v)) errors.push("number");
      else if (validator === "regex") {
        const m = /^(.)(.*)\1([a-z]*)$/s.exec(String(f.config.regex ?? ""));
        try {
          if (m && !new RegExp(m[2], m[3].replace(/[^gimsuy]/g, "")).test(v)) errors.push("regex");
        } catch {
          errors.push("regex");
        }
      } else if (validator === "formula" && !isFormula(v)) errors.push("formula");
      break;
    }
    case "memo":
      if (!isFormula(String(value))) errors.push("formula");
      break;
    case "phone": {
      const [phone, ext] = String(value).split("X", 2);
      if (phone && (!phpIsNumeric(phone) || phone.length < Number(f.config.digits ?? 7))) errors.push("phone");
      if (ext && f.config.ext) {
        if (!phpIsNumeric(ext)) errors.push("phone_ext");
        else if (!phone) errors.push("phone_ext_missing");
      }
      break;
    }
    case "files": {
      const max = Number(f.config.max);
      if (max > 0 && typeof value === "object" && Object.keys(value).length > max) errors.push("files_max");
      break;
    }
  }
  return errors;
}

/** Format::phone */
function formatPhone(phone: string): string {
  const stripped = phone.replace(/[^0-9]/g, "");
  if (stripped.length === 7) return stripped.replace(/([0-9]{3})([0-9]{4})/, "$1-$2");
  if (stripped.length === 10) return stripped.replace(/([0-9]{3})([0-9]{3})([0-9]{4})/, "($1) $2-$3");
  return phone;
}

/**
 * FormField::toString per tipo (usato anche come dato per i filtri e per l'indice). Le date sono
 * formattate con Format::date/datetime se si passano le opzioni, altrimenti restano come salvate.
 */
export function fieldToString(f: FieldDef, value: CleanValue, dates?: DateFormatOptions): string {
  if (value === null || value === undefined) return f.type === "bool" ? "No" : "";
  switch (f.type) {
    case "datetime": {
      if (typeof value !== "string" || !dates) return typeof value === "string" ? value : "";
      const dt = phpParseDateTime(value);
      if (!dt || dt.toSeconds() <= 0) return "";
      return phpFormatDate(dt, dates, !!f.config.time);
    }
    case "bool":
      return value ? "Yes" : "No";
    case "phone": {
      const [phone, ext] = String(value).split("X", 2);
      let out = f.config.format === "us" ? formatPhone(phone) : phone;
      if (ext) out += ` x${ext}`;
      return out;
    }
    default:
      if (isIdValue(value)) return value.label;
      if (typeof value === "object") return Object.values(value).join(", ");
      return String(value);
  }
}

/** FormField::searchable (null = non indicizzabile) */
export function fieldSearchable(f: FieldDef, value: CleanValue, dates?: DateFormatOptions): string | null {
  if (["priority", "topic", "sla", "timezone", "department", "assignee", "thread", "break", "info"].includes(f.type)) return null;
  if (f.type === "memo") return htmlSearchable(value === null ? "" : String(value));
  return searchable(fieldToString(f, value, dates));
}

/** FormField::to_database: valore e value_id per form_entry_values */
export function fieldToDatabase(f: FieldDef, value: CleanValue): { value: string | null; valueId: number | null } {
  if (value === null || value === undefined) return { value: f.type === "bool" ? "0" : null, valueId: null };
  switch (f.type) {
    case "bool":
      return { value: value ? "1" : "0", valueId: null };
    case "priority":
    case "department":
      return isIdValue(value) ? { value: value.label, valueId: value.id } : { value: String(value), valueId: null };
    case "choices":
    case "files":
      return { value: typeof value === "object" ? phpJsonEncode(value) : String(value), valueId: null };
    default:
      if (f.type.startsWith("list-")) return { value: typeof value === "object" ? phpJsonEncode(value) : String(value), valueId: null };
      return { value: typeof value === "object" ? phpJsonEncode(value) : String(value), valueId: null };
  }
}

/** DynamicFormEntryAnswer::getSearchKeys: valore della colonna *__cdata */
export function fieldSearchKeys(f: FieldDef, value: CleanValue): string {
  if (value === null || value === undefined) return f.type === "bool" ? "0" : "";
  if (f.type === "priority" || f.type === "department") return isIdValue(value) ? String(value.id) : "";
  if (f.type === "choices" || f.type.startsWith("list-")) return typeof value === "object" ? Object.keys(value).join(", ") : String(value);
  if (f.type === "bool") return value ? "1" : "0";
  return fieldToDatabase(f, value).value ?? "";
}

/** Testo semplice di un'etichetta (le etichette possono contenere HTML). */
export function plainLabel(label: string): string {
  return phpStripTags(label);
}

/** FormField::to_php: valore pulito da una risposta salvata (form_entry_values) */
export function cleanFromDb(f: FieldDef, value: string | null, valueId: number | null): CleanValue {
  if (value === null || value === undefined) return f.type === "bool" ? false : null;
  switch (f.type) {
    case "bool":
      return !!value && value !== "0";
    case "priority":
    case "department":
      return valueId ? { id: valueId, label: value } : value;
    case "choices":
    case "files": {
      const parsed = phpJsonDecode<Record<string, string> | string | null>(value, null);
      if (parsed && typeof parsed === "object") return parsed;
      return value;
    }
    default:
      if (f.type.startsWith("list-")) {
        const parsed = phpJsonDecode<Record<string, string> | null>(value, null);
        return parsed && typeof parsed === "object" ? parsed : value;
      }
      return value;
  }
}
