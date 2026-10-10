import "server-only";

import { DateTime } from "luxon";

import { DynamicFormField } from "@/lib/osticket/flags";

import type { ConfigNamespace } from "../../config/config";
import { phpFormatDate } from "../../format/datetime";
import { htmlChars, phpStripTags, stripTags } from "../../format/html";
import { phpJsonDecode, phpJsonEncode } from "../../format/php-json";
import { htmlSearchable, phpTrim, sanitizeText, searchable, stripEmoticons } from "../../format/text";
import { intval, isArray, isNumeric, isset, phpLooseEquals, str, truthy, type PhpVal, type PhpVars } from "../../php/values";
import { isFormula, isIp, isPhone, isValidEmail, phpIsNumeric } from "./validator";

/**
 * Campi dei form dinamici (include/class.forms.php + class.dynamic_forms.php): flag di visibilità,
 * configurazione con i default del tipo, parse dell'input, validazione, conversione verso il DB
 * (`form_entry_values.value` / `value_id`), testo per filtri, indice e cdata. Unica definizione dei
 * campi per ticket, task, utenti, organizzazioni e azienda; i validatori sono in ./validator.
 */

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
  return !f.disabled && hasFlag(f, DynamicFormField.ENABLED);
}
export function isVisibleTo(f: FieldDef, who: FormAudience): boolean {
  return isEnabled(f) && hasFlag(f, who === "staff" ? DynamicFormField.AGENT_VIEW : DynamicFormField.CLIENT_VIEW);
}
export function isEditableTo(f: FieldDef, who: FormAudience): boolean {
  return isEnabled(f) && hasFlag(f, who === "staff" ? DynamicFormField.AGENT_EDIT : DynamicFormField.CLIENT_EDIT);
}
export function isRequiredFor(f: FieldDef, who: FormAudience): boolean {
  return hasFlag(f, who === "staff" ? DynamicFormField.AGENT_REQUIRED : DynamicFormField.CLIENT_REQUIRED);
}
/** Scorciatoie per il contesto agente (directory, task, azienda). */
export const isVisibleToStaff = (f: FieldDef) => isVisibleTo(f, "staff");
export const isEditableToStaff = (f: FieldDef) => isEditableTo(f, "staff");
export const isRequiredForStaff = (f: FieldDef) => isRequiredFor(f, "staff");
/** FormField::hasData: niente dati per separatori e testo informativo */
export function hasData(f: FieldDef): boolean {
  return f.type !== "break" && f.type !== "info";
}
/** FormField::isStorable */
export function isStorable(f: FieldDef): boolean {
  return (f.flags & DynamicFormField.EXT_STORED) === 0;
}
/** ThreadEntryField è "presentation only": il corpo diventa il primo messaggio */
export function isPresentationOnly(f: FieldDef): boolean {
  return f.type === "thread";
}
/** Campo con una riga form_entry_values (DynamicFormEntry::create / saveAnswers). */
export function hasAnswerRow(f: FieldDef): boolean {
  return hasData(f) && isStorable(f) && !isPresentationOnly(f);
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

/**
 * ChoiceField::getChoices per il tipo choices (righe "chiave:etichetta"): `list($key, $val) =
 * explode(':', $choice, 2)`, etichetta = chiave se `$val == null` (assente o ""), poi trim di entrambe.
 */
function parseChoiceLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of String(text ?? "").split("\n")) {
    const idx = line.indexOf(":");
    const key = idx >= 0 ? line.slice(0, idx) : line;
    const val = idx >= 0 ? line.slice(idx + 1) : "";
    out[key.trim()] = (val === "" ? key : val).trim();
  }
  return out;
}

/** Scelte di un campo: già risolte (liste, priorità, reparti) o dalla configurazione "choices". */
export function fieldChoices(f: FieldDef): Record<string, string> {
  if (f.choices) return f.choices;
  const raw = f.config.choices;
  if (raw && typeof raw === "object") return raw as Record<string, string>;
  return parseChoiceLines(String(raw ?? ""));
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

/** Sorgente dei valori (POST/vars): per nome del campo o per id, come Widget::getValue. */
export type FormSource = Record<string, unknown>;

/**
 * Widget::getValue di base: primo nome valorizzato (isset) tra nome e id del campo. Al posto del
 * nome "hash" dei form PHP (Widget::$name) la sorgente TS usa il nome o l'id del campo; l'interno
 * del telefono è `<nome o id>-ext`.
 */
function rawValue(f: FieldDef, source: FormSource): PhpVal {
  for (const k of [f.name, String(f.id)]) if (k && isset(source as PhpVars, k)) return source[k] as PhpVal;
  return null;
}

/** Prima chiave di un array PHP (reset + key), null se vuoto. */
function firstKey(v: PhpVal): string | null {
  return isArray(v) ? (Object.keys(v)[0] ?? null) : null;
}

/** Array PHP chiave → etichetta come mappa di stringhe. */
function strMap(v: PhpVal): Record<string, string> {
  const out: Record<string, string> = {};
  if (isArray(v)) for (const [k, x] of Object.entries(v)) out[k] = str(x);
  return out;
}

/**
 * SelectionField::lookupChoice (liste personalizzate): voce per etichetta (array_search debole sulle
 * scelte; una chiave "0" non vale). Le voci disattivate e la ricerca per abbreviazione (`extra`), che
 * nel PHP interrogano il DB, non sono replicate.
 */
function lookupListChoice(choices: Record<string, string>, value: PhpVal): Record<string, string> | null {
  const k = Object.keys(choices).find((key) => phpLooseEquals(choices[key], value));
  return k && truthy(k) ? { [k]: choices[k] } : null;
}

/**
 * ChoicesWidget::getValue (scelte, liste, priorità, reparti, fusi): un valore "falso" vale null; ogni
 * valore inviato presente fra le scelte (o trovato da lookupChoice) entra nella selezione; un primo
 * valore sconosciuto viene restituito tale e quale (testo da validare/convertire in parse).
 */
function choicesWidgetValue(raw: PhpVal, choices: Record<string, string>, lookup?: (v: PhpVal) => Record<string, string> | null): PhpVal {
  if (!truthy(raw)) return null;
  const items: [string, PhpVal][] = isArray(raw) ? Object.entries(raw) : [["0", raw]];
  const values: Record<string, string> = {};
  for (const [k, v] of items) {
    const key = isArray(v) ? null : str(v);
    const found = key === null ? null : Object.hasOwn(choices, key) ? { [key]: choices[key] } : (lookup?.(v) ?? null);
    if (found) {
      // $values[$v] = …, $values += $i
      for (const [ik, iv] of Object.entries(found)) if (ik === key || !Object.hasOwn(values, ik)) values[ik] = iv;
    } else if (!truthy(k) && truthy(v)) return v;
  }
  return values;
}

/**
 * ChoiceField::to_php sul valore del widget (parse = to_php($value ?: null)): testo JSON decodificato,
 * elenco "a,b" ridotto alle chiavi note, selezione singola ridotta alla chiave se non multiselect.
 * La chiave nota diventa {chiave: etichetta} (rappresentazione TS, equivalente per to_database,
 * toString e getKeys); un valore sconosciuto resta testo, come nel PHP.
 */
function choicesToPhp(f: FieldDef, choices: Record<string, string>, input: PhpVal): CleanValue {
  let value: PhpVal = input;
  if (!truthy(value)) return null;
  if (typeof value === "string") {
    const decoded = phpJsonDecode<PhpVal>(value, null);
    if (truthy(decoded)) value = decoded;
  }
  if (typeof value === "string" && value.indexOf(",") > 0) {
    const vals = value.split(",").map((v) => phpTrim(v));
    const known: Record<string, string> = {};
    for (const v of vals) if (Object.hasOwn(choices, v)) known[v] = choices[v];
    value = truthy(known) ? known : vals[0];
  }
  if (!truthy(f.config.multiselect as PhpVal) && isArray(value) && Object.keys(value).length < 2) value = firstKey(value);
  if (value === null) return null;
  if (isArray(value)) return strMap(value);
  const key = str(value);
  return Object.hasOwn(choices, key) ? { [key]: choices[key] } : key;
}

/**
 * SelectionField::parse (liste): selezione {id: valore} delle voci note per chiave o per valore; un
 * valore non riconosciuto non produce selezione. Non replicati (il PHP interroga il DB): le voci
 * disattivate cercate per id e il numero sconosciuto salvato come voce anonima ("[22]").
 */
function listToPhp(choices: Record<string, string>, input: PhpVal): CleanValue {
  let value: PhpVal = input;
  if (truthy(value) && !isArray(value)) {
    const decoded = phpJsonDecode<PhpVal>(str(value), null);
    value = truthy(decoded) ? decoded : [value];
  }
  const sel: Record<string, string> = {};
  if (truthy(value) && isArray(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (truthy(k) && Object.hasOwn(choices, String(intval(k)))) sel[String(intval(k))] = choices[String(intval(k))];
      else if (Object.hasOwn(choices, k)) sel[k] = choices[k];
      else if (!isArray(v) && Object.hasOwn(choices, str(v))) sel[str(v)] = choices[str(v)];
    }
  }
  return Object.keys(sel).length ? sel : null;
}

/**
 * Widget::getValue per tipo (il valore che FormField::parse riceve). `timezone` è il fuso dell'utente
 * corrente ($cfg->getTimezone()) usato da DatetimePickerWidget.
 */
function widgetValue(f: FieldDef, source: FormSource, timezone: string): PhpVal {
  const raw = rawValue(f, source);
  switch (f.type) {
    case "phone": {
      // PhoneNumberWidget::getValue: $base . $ext, con 'X' davanti solo a un interno "vero" (un
      // interno "0" viene accodato senza separatore: "0655512" + "0" → "06555120")
      if (raw === null) return null;
      const ext = source[`${f.name || f.id}-ext`] as PhpVal;
      return str(raw) + (truthy(ext) ? `X${str(ext)}` : str(ext));
    }
    case "choices":
      return choicesWidgetValue(raw, fieldChoices(f));
    case "priority":
    case "department":
    case "timezone":
      return choicesWidgetValue(raw, f.choices ?? {});
    case "datetime": {
      // DatetimePickerWidget::getValue: data letta nel fuso del PHP (UTC), portata nel fuso del
      // campo/utente e salvata come 'Y-m-d H:i:s T' (es. "2026-09-30 02:00:00 CEST"); valore "falso"
      // o non interpretabile invariato
      if (!truthy(raw)) return raw;
      const dt = phpParseDateTime(str(raw));
      if (!dt) return raw;
      const z = dt.setZone(String(f.config.timezone || timezone || "UTC"));
      return `${z.toFormat("yyyy-MM-dd HH:mm:ss")} ${phpTzAbbr(z)}`;
    }
    default:
      if (f.type.startsWith("list-")) {
        const choices = f.choices ?? {};
        return choicesWidgetValue(raw, choices, (v) => lookupListChoice(choices, v));
      }
      return raw;
  }
}

/**
 * FormField::parse per tipo, sul valore del widget o su un valore diretto (import CSV:
 * `$f->parse(trim($csv))`). Valore assente (null) → null: il PHP darebbe "" per il testo, ma la
 * risposta salvata resta comunque NULL (nuova entry) o quella precedente (entry esistente).
 */
export function parseFieldValue(f: FieldDef, value: PhpVal): CleanValue {
  switch (f.type) {
    case "text":
      // TextboxField::parse: Format::strip_emoticons(Format::striptags($value)), nessun trim
      return value === null || value === undefined ? null : stripEmoticons(stripTags(str(value)));
    case "memo": {
      // TextareaField::parse: nessun trim (solo Format::sanitize se HTML)
      if (value === null || value === undefined || value === false) return null;
      return f.config.html ? sanitizeText(str(value)) : str(value);
    }
    case "phone": {
      // PhoneField::parse: solo cifre e "X", altrimenti il testo originale (non rifilato) da validare
      if (value === null || value === undefined || value === false) return null;
      const base = str(value);
      return base.replace(/[^\dX]/g, "") || base;
    }
    case "bool":
      // BooleanField::getClean usa il valore del widget senza parse: vero/falso come (bool) PHP
      return truthy(value);
    case "choices":
      return choicesToPhp(f, fieldChoices(f), value);
    case "timezone": {
      // ChoiceField::parse: chiave della selezione o testo inviato
      const v = choicesToPhp({ ...f, config: { ...f.config, multiselect: false } }, f.choices ?? {}, value);
      return v !== null && typeof v === "object" ? (Object.keys(v)[0] ?? null) : v;
    }
    case "priority":
    case "department": {
      // PriorityField/DepartmentField::parse($id): chiave della selezione (o id inviato) fra le scelte
      const id = isArray(value) ? firstKey(value) : value === null || value === undefined ? null : str(value);
      if (!id || !f.choices || !Object.hasOwn(f.choices, String(Number(id)))) return null;
      return { id: Number(id), label: f.choices[String(Number(id))] };
    }
    case "datetime":
      if (value === null || value === undefined || value === false) return null;
      return typeof value === "string" ? phpTrim(value) : str(value);
    case "files": {
      // valori "id,nome" (POST) o {id: nome}
      const out: Record<string, string> = {};
      const items = Array.isArray(value) ? value : isArray(value) ? Object.entries(value).map(([k, v]) => `${k},${str(v)}`) : [];
      for (const item of items) {
        const [id, ...rest] = str(item).split(",");
        if (id) out[id] = rest.join(",");
      }
      return Object.keys(out).length ? out : null;
    }
    default:
      if (f.type.startsWith("list-")) return listToPhp(f.choices ?? {}, value);
      // FormField::parse: trim delle stringhe
      if (value === null || value === undefined) return null;
      return typeof value === "string" ? phpTrim(value) : str(value);
  }
}

/**
 * Valore "pulito" di un campo da una sorgente (FormField::getClean = parse(Widget::getValue)): unica
 * lettura dell'input dei form dinamici per ticket, portale, utenti, organizzazioni, task e azienda.
 */
export function parseField(f: FieldDef, source: FormSource, timezone = "UTC"): CleanValue {
  return parseFieldValue(f, widgetValue(f, source, timezone));
}

/** Il campo ha un valore nella sorgente (isset per nome o id, come Widget::getValue). */
export function inSource(f: FieldDef, source: FormSource): boolean {
  return rawValue(f, source) !== null;
}

/**
 * FormField::getClean per un campo di un'entry esistente (Widget::parseValue): il valore della sorgente
 * o, se il campo vi è assente, la risposta attuale (DynamicFormEntryAnswer::getValue). È il valore che
 * isValid() valida e saveAnswers() salva: un campo assente mantiene la risposta precedente. Le modifiche
 * (FormField::getChanges) leggono invece il solo widget: assente → nuovo valore nullo.
 */
export function parseFieldOrAnswer(f: FieldDef, source: FormSource, answer: { value: string | null; valueId: number | null } | null | undefined, timezone = "UTC"): CleanValue {
  return answer && !inSource(f, source) ? cleanFromDb(f, answer.value, answer.valueId) : parseField(f, source, timezone);
}

/**
 * Valore pulito nella forma di FormField::getClean del PHP, per riusarlo come sorgente (User::fromVars
 * riceve getClean() e lo rilegge con i widget): la scelta singola torna alla sola chiave.
 */
export function phpCleanValue(f: FieldDef, v: CleanValue): CleanValue {
  if (f.type === "choices" && !truthy(f.config.multiselect as PhpVal) && v && typeof v === "object" && !isIdValue(v) && Object.keys(v).length === 1) return Object.keys(v)[0];
  return v;
}

/**
 * Codici d'errore dei validatori (testo inglese del PHP, tradotto dalla UI tramite il codice): ogni form
 * che mostra gli errori di validateField ha una traduzione per ciascuno (test/unit/field-error-messages).
 */
export const FIELD_ERROR_CODES = ["required", "email", "phone", "ip", "number", "regex", "formula", "phone_ext", "phone_ext_missing", "files_max", "date_past"] as const;
export type FieldErrorCode = (typeof FIELD_ERROR_CODES)[number];

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
      if (validator === "email" && !(await isValidEmail(v, cfg.bool("verify_email_addrs")))) errors.push("email");
      else if (validator === "phone" && !isPhone(v)) errors.push("phone");
      else if (validator === "ip" && !isIp(v)) errors.push("ip");
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
export function formatPhone(phone: string): string {
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
      return phpFormatDate(dt, dates.cfg, dates.timezone, f.config.time ? "datetime" : "date");
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
      if (f.type === "choices" && typeof value === "string") return Object.values(choiceSelection(f, value)).join(", ");
      if (typeof value === "object") return Object.values(value).join(", ");
      return String(value);
  }
}

/**
 * ChoiceField::getChoice per un valore testuale: la scelta corrispondente o, se sconosciuto, quella
 * predefinita del campo (nessuna se manca).
 */
function choiceSelection(f: FieldDef, value: string): Record<string, string> {
  const choices = fieldChoices(f);
  if (Object.hasOwn(choices, value)) return { [value]: choices[value] };
  const d = str(f.config.default as PhpVal);
  return truthy(d) && Object.hasOwn(choices, d) ? { [d]: choices[d] } : {};
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

/**
 * Valore attuale di una risposta nei dati di FormField::getChanges (to_database(to_php($value))):
 * DatetimeField::to_php dà 0 per un valore non numerico con strtotime() <= 0 (anche NULL); gli altri
 * tipi restano come salvati.
 */
export function answerChangeValue(f: FieldDef, value: string | null): string | number | null {
  if (f.type !== "datetime" || (value !== null && isNumeric(value))) return value;
  const dt = value === null ? null : phpParseDateTime(value);
  return !dt || dt.toSeconds() <= 0 ? 0 : value;
}

/** DynamicFormEntryAnswer::getSearchKeys: valore della colonna *__cdata */
export function fieldSearchKeys(f: FieldDef, value: CleanValue): string {
  if (value === null || value === undefined) return f.type === "bool" ? "0" : "";
  if (f.type === "priority" || f.type === "department") return isIdValue(value) ? String(value.id) : "";
  if (f.type === "choices" && typeof value === "string") return Object.keys(choiceSelection(f, value)).join(", ");
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
