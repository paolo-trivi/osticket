import "server-only";

import { isset, truthy, type PhpVal, type PhpVars } from "../../php/values";
import type { ConfigValue } from "./config-write";
import type { Errors } from "./validator";

/** Funzioni comuni alle sezioni di OsticketConfig::update*Settings. */

/** isset($vars[k]) ? 1 : 0 */
export const isset1 = (vars: PhpVars, k: string) => (isset(vars, k) ? 1 : 0);

/** Valore scalare di una variabile per Config::update (gli array non sono previsti nei form). */
export function v(x: PhpVal): ConfigValue {
  if (x === undefined || x === null) return null;
  if (Array.isArray(x) || typeof x === "object") return "Array";
  return x;
}

/** Controllo "Select recipient(s)": l'avviso attivo richiede almeno un destinatario. */
export function needRecipients(vars: PhpVars, errors: Errors, active: string, keys: string[]): void {
  if (truthy(vars[active]) && !keys.some((k) => isset(vars, k))) errors[active] = "recipients";
}
