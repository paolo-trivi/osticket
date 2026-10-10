import "server-only";

import { isNumeric, str, truthy, type PhpVars } from "../../php/values";

/**
 * Validator::process($fields, $vars, $errors) (include/class.validator.php) per i tipi usati
 * dalle impostazioni: int, string, email, cs-url, cs-domain, ipaddr. Gli errori sono codici
 * (`required`/`invalid`…) al posto dei messaggi tradotti del PHP.
 */
export interface FieldRule {
  type: "int" | "string" | "email" | "cs-url" | "cs-domain" | "ipaddr";
  required?: boolean;
  min?: number;
  /** codice d'errore restituito (come $field['error']) */
  error: string;
}

export type Errors = Record<string, string>;

function matchList(value: string, re: RegExp): boolean {
  // explode(',', …) + ltrim($v) + preg_match_all
  return value.split(",").every((v) => re.test(v.replace(/^[\s\0\x0B]+/, "")));
}

export function validate(fields: Record<string, FieldRule>, vars: PhpVars, errors: Errors, isEmail?: (v: string) => boolean): boolean {
  const out: Errors = {};
  for (const [k, field] of Object.entries(fields)) {
    const input = vars[k];
    if (!field.required && !truthy(input)) continue;
    if ((field.required && (input === undefined || input === null)) || (!truthy(input) && field.type !== "int")) {
      out[k] = field.error;
      continue;
    }
    const v = str(input);
    switch (field.type) {
      case "int":
        if (!isNumeric(input ?? null)) out[k] = field.error;
        else if (field.min && Number(v) < field.min) out[k] = field.error;
        break;
      case "string":
        if (typeof input !== "string") out[k] = field.error;
        break;
      case "email":
        if (!isEmail || !isEmail(v)) out[k] = field.error;
        break;
      case "cs-domain":
        if (!matchList(v, /^([a-z0-9|-]+\.)*[a-z0-9|-]+\.[a-z]+$/)) out[k] = field.error;
        break;
      case "cs-url":
        if (!matchList(v, /^(https?:\/\/)?((\*\.|\w+\.)?[\w-]+(\.[a-zA-Z]+)?(:([0-9]+|\*))?)+$/)) out[k] = field.error;
        break;
      case "ipaddr":
        if (!matchList(v, /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/)) out[k] = field.error;
        break;
    }
  }
  // array_merge($errors, $val->errors())
  Object.assign(errors, out);
  return Object.keys(errors).length === 0;
}

/**
 * Validator::is_username (class.validator.php): almeno 2 byte, solo lettere/cifre/._- e non
 * numerico. Restituisce il codice dell'errore o "".
 */
export function usernameError(username: string): "" | "too_short" | "invalid_chars" {
  if (Buffer.byteLength(username, "utf8") < 2) return "too_short";
  if (isNumeric(username) || !/^[\p{L}\d._-]+$/u.test(username)) return "invalid_chars";
  return "";
}
