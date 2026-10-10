import "server-only";

import type { ConfigNamespace } from "../../config/config";
import { htmlChars } from "../../format/html";
import { hasData, isIdValue, type CleanValue, type FieldDef } from "./field-def";
import { isFormula, isIp, isPhone, isValidEmail, phpIsNumeric } from "./validator";

/** Validazione dei valori puliti dei campi (FormField::validateEntry); i validatori sono in ./validator. */

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
