import "server-only";

import { phpLooseEquals } from "../ticket/record";

/**
 * Variabili di un POST PHP ($_POST): stringhe, array (`ids[]`) e mappe (`member_role[3]`).
 * Le funzioni dell'area admin ricevono gli stessi `$vars` che il PHP riceve dai form di scp/,
 * così le regole di validazione e scrittura si replicano riga per riga (isset, truthiness, cast).
 */
export type PhpVal = string | number | boolean | null | undefined | PhpVal[] | { [k: string]: PhpVal };
export type PhpVars = Record<string, PhpVal>;

export { phpLooseEquals };

/** isset($vars[$k]) */
export function isset(vars: PhpVars | null | undefined, k: string): boolean {
  return !!vars && vars[k] !== undefined && vars[k] !== null;
}

/** Truthiness PHP: "", "0", 0, false, null, [] → false. */
export function truthy(v: PhpVal): boolean {
  if (v === undefined || v === null || v === false || v === "" || v === "0" || v === 0) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

/** (string) $v */
export function str(v: PhpVal): string {
  if (v === undefined || v === null || v === false) return "";
  if (v === true) return "1";
  if (Array.isArray(v) || typeof v === "object") return "Array";
  return String(v);
}

/** is_numeric($v) di PHP 8 (spazi iniziali e finali ammessi). */
export function isNumeric(v: PhpVal): boolean {
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v !== "string") return false;
  return /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/.test(v);
}

/** (int) $v: prefisso numerico della stringa, 0 se assente. */
export function intval(v: PhpVal): number {
  if (typeof v === "number") return Math.trunc(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v !== "string") return 0;
  const m = /^\s*[+-]?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(v);
  return m ? Math.trunc(Number(m[0])) : 0;
}

/** $a ?: $b */
export function elvis<T>(v: PhpVal, fallback: T): PhpVal | T {
  return truthy(v) ? v : fallback;
}

/** Array PHP come lista di valori (foreach $vars['x'] as $v). */
export function list(v: PhpVal): PhpVal[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") return Object.values(v);
  return [];
}

/** $vars['x'][$k] su una mappa PHP. */
export function at(v: PhpVal, k: string | number): PhpVal {
  if (Array.isArray(v)) return v[Number(k)];
  if (v && typeof v === "object") return (v as Record<string, PhpVal>)[String(k)];
  return undefined;
}

/** in_array($needle, $haystack) con confronto debole. */
export function inArray(needle: PhpVal, haystack: PhpVal): boolean {
  return list(haystack).some((h) => phpLooseEquals(h as never, needle as never));
}

const ENTITY = /^&(#\d+|#x[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/;

/**
 * Format::htmlchars($var): htmlspecialchars((string) $var, ENT_COMPAT | ENT_HTML401, 'UTF-8', false)
 * (senza doppia codifica delle entità già presenti; apici singoli invariati). Gli array sono
 * trasformati elemento per elemento.
 */
export function formatHtmlchars(v: PhpVal): PhpVal {
  if (Array.isArray(v)) return v.map(formatHtmlchars);
  if (v && typeof v === "object") {
    const out: Record<string, PhpVal> = {};
    for (const [k, x] of Object.entries(v)) out[k] = formatHtmlchars(x);
    return out;
  }
  const s = str(v);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "&") out += ENTITY.test(s.slice(i)) ? "&" : "&amp;";
    else if (c === "<") out += "&lt;";
    else if (c === ">") out += "&gt;";
    else if (c === '"') out += "&quot;";
    else out += c;
  }
  return out;
}

/** Format::htmlchars su tutte le variabili (SLA::update, updateSystemSettings). */
export function htmlcharsVars(vars: PhpVars): PhpVars {
  const out: PhpVars = {};
  for (const [k, v] of Object.entries(vars)) out[k] = v === undefined || v === null ? v : formatHtmlchars(v);
  return out;
}

/**
 * preg_match('`(?!<\\\)#`', $format): il PHP voleva un lookbehind ma ha scritto un lookahead
 * negativo, quindi basta un "#" qualsiasi (bug innocuo replicato).
 */
export function hasHash(format: PhpVal): boolean {
  return str(format).includes("#");
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
