import "server-only";

import { phpFormatDate } from "../../format/datetime";
import { phpJsonDecode, phpJsonEncode } from "../../format/php-json";
import { htmlSearchable, searchable } from "../../format/text";
import { isNumeric, str, truthy, type PhpVal } from "../../php/values";
import { phpParseDateTime } from "./field-dates";
import { fieldChoices, isIdValue, type CleanValue, type DateFormatOptions, type FieldDef } from "./field-def";

/**
 * Conversioni dei valori puliti dei campi: verso il DB (`form_entry_values.value` / `value_id`) e
 * ritorno (to_php), testo per filtri, indice e template, chiavi della tabella *__cdata, dati di getChanges.
 */

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
