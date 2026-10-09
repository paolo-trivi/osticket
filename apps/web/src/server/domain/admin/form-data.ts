import "server-only";

import type { PhpVal, PhpVars } from "./php";

/**
 * FormData → $_POST di PHP: `nome[]` diventa una lista, `nome[chiave]` una mappa, gli altri campi
 * stringhe (l'ultimo valore vince, come PHP). I campi interni di Next (`$ACTION_…`) sono ignorati.
 */
export function parsePhpForm(form: FormData): PhpVars {
  const out: PhpVars = {};
  for (const [rawKey, rawVal] of form.entries()) {
    if (rawKey.startsWith("$ACTION")) continue;
    if (typeof rawVal !== "string") continue;
    const m = /^([^[\]]+)((?:\[[^\]]*\])*)$/.exec(rawKey);
    if (!m) continue;
    const base = m[1];
    const path = [...m[2].matchAll(/\[([^\]]*)\]/g)].map((x) => x[1]);
    if (!path.length) {
      out[base] = rawVal;
      continue;
    }
    let container: PhpVal = out[base];
    if (path[0] === "") {
      if (!Array.isArray(container)) container = out[base] = [];
      (container as PhpVal[]).push(rawVal);
      continue;
    }
    if (!container || typeof container !== "object" || Array.isArray(container)) container = out[base] = {};
    let obj = container as Record<string, PhpVal>;
    for (let i = 0; i < path.length - 1; i++) {
      const k = path[i];
      if (!obj[k] || typeof obj[k] !== "object" || Array.isArray(obj[k])) obj[k] = {};
      obj = obj[k] as Record<string, PhpVal>;
    }
    obj[path[path.length - 1]] = rawVal;
  }
  return out;
}

/** Id numerici selezionati (ids[]) di una lista. */
export function selectedIds(vars: PhpVars, name = "ids"): number[] {
  const v = vars[name];
  const list = Array.isArray(v) ? v : [];
  return list.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0);
}
