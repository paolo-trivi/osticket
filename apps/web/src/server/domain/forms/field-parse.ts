import "server-only";

import { sanitizeText, phpTrim, stripEmoticons } from "../../format/text";
import { stripTags } from "../../format/html";
import { phpJsonDecode } from "../../format/php-json";
import { intval, isArray, isset, phpLooseEquals, str, truthy, type PhpVal, type PhpVars } from "../../php/values";
import { cleanFromDb } from "./field-convert";
import { phpParseDateTime, phpTzAbbr } from "./field-dates";
import { fieldChoices, isIdValue, type CleanValue, type FieldDef, type FormSource } from "./field-def";

/**
 * Lettura dell'input dei campi (Widget::getValue + FormField::parse = getClean) per ticket, portale,
 * utenti, organizzazioni, task e azienda.
 */

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
