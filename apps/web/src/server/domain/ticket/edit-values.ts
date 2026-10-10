import "server-only";

import { DateTime } from "luxon";

import { phpJsonEncode } from "../../format/php-json";
import { editorSpacing, phpTrim, sanitizeText } from "../../format/text";
import { phpParseDateTime } from "../forms/fields";

/**
 * Valori della modifica del ticket: origini ammesse, corpo delle note, date inserite dall'agente e
 * campo scadenza del form, dati JSON dell'evento "edited" con l'ordine delle chiavi del PHP.
 */

/** Ticket::getSources() */
export const TICKET_SOURCE_KEYS = ["Phone", "Email", "Web", "API", "Other"] as const;

/** Frammento JSON già serializzato da inserire così com'è in phpAssocJson. */
export class RawJson {
  constructor(readonly json: string) {}
}

/** JSON di un array associativo PHP con l'ordine delle chiavi preservato (anche numeriche). */
export function phpAssocJson(pairs: [string, unknown][]): string {
  return `{${pairs.map(([k, v]) => `${phpJsonEncode(String(k))}:${v instanceof RawJson ? v.json : phpJsonEncode(v)}`).join(",")}}`;
}

/** ThreadEntryBody::clean per l'HTML di un agente: '' se il corpo è vuoto (solo spazi, <, >, b, r, /). */
export function cleanHtmlBody(body: string): string {
  const b = phpTrim(body ?? "", " <>br/\t\n\r") ? body : "";
  return b ? sanitizeText(editorSpacing(b)) : "";
}

/**
 * Data inserita dall'agente → datetime del DB come Ticket::update / updateField: la stringa è
 * interpretata da Format::parseDateTime nel fuso predefinito del PHP (UTC, anche se l'agente ha un
 * altro fuso: stranezza del PHP replicata) e convertita nel fuso del DB.
 */
export function userDateToDb(input: string, dbZone: string): { db: string; past: boolean } | null {
  const dt = phpParseDateTime(input);
  if (!dt) return null;
  return { db: dt.setZone(dbZone).toFormat("yyyy-MM-dd HH:mm:ss"), past: dt.toMillis() <= Date.now() };
}

/** Format::truncate($text, $len) senza parola spezzata: come il PHP, taglia e aggiunge "..." */
export function truncate(text: string, len: number): string {
  if (text.length <= len) return text;
  const cut = text.slice(0, len);
  const sp = cut.lastIndexOf(" ");
  return `${sp > 0 ? cut.slice(0, sp) : cut}...`;
}

/** Data/ora del DB per il campo "scadenza" del form (datetime-local, interpretato come il PHP: UTC). */
export function dbDateToInput(value: string | null, dbZone: string): string {
  if (!value || value.startsWith("0000")) return "";
  const dt = DateTime.fromSQL(value, { zone: dbZone });
  return dt.isValid ? dt.setZone("UTC").toFormat("yyyy-MM-dd'T'HH:mm") : "";
}
