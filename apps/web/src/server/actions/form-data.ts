import "server-only";

import { sanitizeText } from "@/server/format/text";

/**
 * Lettura dei campi FormData nelle server action (form del pannello agenti e del portale). I form
 * dell'area admin passano invece da parsePhpForm (server/domain/admin/form-data).
 */

/** Valore testuale di un campo (`fallback`, di norma "", se assente). */
export function formStr(form: FormData, name: string, fallback = ""): string {
  return String(form.get(name) ?? fallback);
}

/** Valore numerico di un campo (0 se assente, NaN se non numerico). */
export function formNum(form: FormData, name: string): number {
  return Number(form.get(name) ?? 0);
}

/** Casella/flag inviata con valore "1". */
export function formFlag(form: FormData, name: string): boolean {
  return form.get(name) === "1";
}

/** Valori testuali di un campo ripetuto (liste, token degli allegati). */
export function formStrs(form: FormData, name: string): string[] {
  return form.getAll(name).map(String);
}

/** Id selezionati di un campo ripetuto: solo numeri positivi, nell'ordine di invio. */
export function formIds(form: FormData, name: string): number[] {
  return form
    .getAll(name)
    .map(Number)
    .filter((n) => n > 0);
}

/**
 * Campo HTML dei form (TextareaField html): vuoto se contiene solo tag e spazi, altrimenti sanificato
 * come Format::sanitize (o grezzo con `sanitize: false`, quando lo fa il dominio).
 */
export function formHtml(form: FormData, name = "comments", { sanitize = true }: { sanitize?: boolean } = {}): string {
  const raw = formStr(form, name);
  if (!raw.replace(/<[^>]*>|&nbsp;|\s/g, "")) return "";
  return sanitize ? sanitizeText(raw) : raw;
}
