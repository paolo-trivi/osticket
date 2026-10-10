import "server-only";

import { DynamicFormField } from "@/lib/osticket/flags";

import type { ConfigNamespace } from "../../config/config";
import { phpStripTags } from "../../format/html";
import { phpJsonDecode } from "../../format/php-json";

/**
 * Definizione dei campi dei form dinamici (FormField / DynamicFormField): flag di visibilità e
 * memorizzazione, configurazione con i default del tipo, scelte, forma dei valori puliti.
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

/** Opzioni di formattazione delle date come Format::date/datetime (formati ICU della config core) */
export interface DateFormatOptions {
  cfg: ConfigNamespace;
  /** fuso dell'utente corrente ($cfg->getTimezone()) */
  timezone: string;
}

/** Sorgente dei valori (POST/vars): per nome del campo o per id, come Widget::getValue. */
export type FormSource = Record<string, unknown>;

/** Testo semplice di un'etichetta (le etichette possono contenere HTML). */
export function plainLabel(label: string): string {
  return phpStripTags(label);
}
