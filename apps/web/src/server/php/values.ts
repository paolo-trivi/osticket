import "server-only";

import { htmlChars } from "../format/html";
import { sanitizeText } from "../format/text";

/**
 * Semantica PHP 8 dei valori di `$_POST`/`$vars` (fonte unica per tutto `src/server`).
 * Le funzioni di dominio ricevono gli stessi `$vars` che il PHP riceve dai form, così validazioni
 * e scritture si replicano riga per riga (isset, truthiness, cast, confronto debole).
 *
 * Convenzioni: un numero JS intero sicuro vale come `int` PHP, gli altri numeri come `float`;
 * array e mappe (`ids[]`, `member_role[3]`) sono entrambi array PHP; `null`/`undefined` in una
 * PhpVars equivalgono a una chiave assente (isset falso).
 */
export type PhpVal = string | number | boolean | null | undefined | PhpVal[] | { [k: string]: PhpVal };
export type PhpVars = Record<string, PhpVal>;

/** Spazi ammessi da is_numeric e dai cast numerici di PHP (" \t\n\r\v\f", non gli spazi Unicode). */
const WS = "[ \\t\\n\\r\\v\\f]";
const NUMERIC = new RegExp(`^${WS}*[+-]?(\\d+(\\.\\d*)?|\\.\\d+)([eE][+-]?\\d+)?${WS}*$`);
const NUMERIC_PREFIX = new RegExp(`^${WS}*[+-]?(\\d+(\\.\\d*)?|\\.\\d+)([eE][+-]?\\d+)?`);
const TRIM_WS = new RegExp(`^${WS}+|${WS}+$`, "g");

/** is_array($v): liste e mappe (non istanze come Date o Buffer). */
export function isArray(v: unknown): v is PhpVal[] | { [k: string]: PhpVal } {
  if (Array.isArray(v)) return true;
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** isset($vars[$k]) */
export function isset(vars: PhpVars | null | undefined, k: string): boolean {
  return !!vars && vars[k] !== undefined && vars[k] !== null;
}

/** (bool) $v: falsi "", "0", 0, 0.0, false, null e l'array vuoto; "0.0", " 0" e NAN sono veri. */
export function truthy(v: PhpVal): boolean {
  if (v === undefined || v === null || v === false || v === "" || v === "0" || v === 0) return false;
  if (isArray(v)) return Object.keys(v).length > 0;
  return true;
}

/** (string) di un float con precision=14 (formato %.14G di zend_gcvt: "0.3", "1.0E+20", "-0"). */
function floatString(n: number): string {
  if (Number.isNaN(n)) return "NAN";
  if (!Number.isFinite(n)) return n > 0 ? "INF" : "-INF";
  if (n === 0) return Object.is(n, -0) ? "-0" : "0";
  const [mant, e] = n.toExponential(13).split("e");
  const exp = Number(e);
  const digits = mant.replace(/^-/, "").replace(".", "").replace(/0+$/, "");
  let out: string;
  if (exp < -4 || exp >= 14) out = `${digits[0]}.${digits.slice(1) || "0"}E${exp < 0 ? "-" : "+"}${Math.abs(exp)}`;
  else if (exp < 0) out = `0.${"0".repeat(-exp - 1)}${digits}`;
  else if (digits.length > exp + 1) out = `${digits.slice(0, exp + 1)}.${digits.slice(exp + 1)}`;
  else out = digits + "0".repeat(exp + 1 - digits.length);
  return n < 0 ? `-${out}` : out;
}

/** (string) $v: true → "1", false/null → "", array → "Array". */
export function str(v: PhpVal): string {
  if (v === undefined || v === null || v === false) return "";
  if (v === true) return "1";
  if (typeof v === "number") return Number.isSafeInteger(v) && !Object.is(v, -0) ? String(v) : floatString(v);
  if (isArray(v)) return "Array";
  return String(v);
}

/** is_numeric($v) di PHP 8: spazi iniziali e finali ammessi, niente esadecimali, int/float sempre numerici. */
export function isNumeric(v: PhpVal): boolean {
  if (typeof v === "number") return true;
  return typeof v === "string" && NUMERIC.test(v);
}

/** (int) $v: prefisso numerico della stringa (anche esponenziale), 0 se assente; array non vuoto → 1. */
export function intval(v: PhpVal): number {
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) + 0 : 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (isArray(v)) return truthy(v) ? 1 : 0;
  if (typeof v !== "string") return 0;
  const m = NUMERIC_PREFIX.exec(v);
  const n = m ? Number(m[0].replace(TRIM_WS, "")) : 0;
  return Number.isFinite(n) ? Math.trunc(n) + 0 : 0;
}

/** Array PHP come lista di valori (foreach $vars['x'] as $v). */
export function list(v: PhpVal): PhpVal[] {
  if (Array.isArray(v)) return v;
  if (isArray(v)) return Object.values(v);
  return [];
}

/** $vars['x'][$k] su una mappa PHP. */
export function at(v: PhpVal, k: string | number): PhpVal {
  if (Array.isArray(v)) return v[Number(k)];
  if (isArray(v)) return v[String(k)];
  return undefined;
}

/**
 * Confronto debole `$a == $b` di PHP 8: bool e null convertono l'altro operando, due stringhe
 * numeriche si confrontano come numeri, numero e stringa non numerica come stringhe ("abc" != 0),
 * gli array per coppie chiave/valore. Altri tipi JS (Date, bigint…) si confrontano come stringhe.
 */
export function phpLooseEquals(a: unknown, b: unknown): boolean {
  if (a === undefined) a = null;
  if (b === undefined) b = null;
  if (a === b) return true;
  if (typeof a === "boolean" || typeof b === "boolean") return truthy(a as PhpVal) === truthy(b as PhpVal);
  if (a === null || b === null) {
    const other = (a === null ? b : a) as PhpVal;
    return typeof other === "string" ? other === "" : !truthy(other);
  }
  if (isArray(a) || isArray(b)) {
    if (!isArray(a) || !isArray(b)) return false;
    const ka = Object.keys(a);
    if (ka.length !== Object.keys(b).length) return false;
    const rb = b as Record<string, PhpVal>;
    return ka.every((k) => Object.hasOwn(rb, k) && phpLooseEquals((a as Record<string, PhpVal>)[k], rb[k]));
  }
  if (typeof a === "number" && typeof b === "number") return a === b;
  if ((typeof a === "number" || typeof a === "string") && (typeof b === "number" || typeof b === "string")) {
    if (isNumeric(a) && isNumeric(b)) return numberOf(a) === numberOf(b);
    return str(a) === str(b);
  }
  return String(a) === String(b);
}

function numberOf(v: string | number): number {
  return typeof v === "number" ? v : Number(v.replace(TRIM_WS, ""));
}

/** in_array($needle, $haystack) con confronto debole. */
export function inArray(needle: PhpVal, haystack: PhpVal): boolean {
  return list(haystack).some((h) => phpLooseEquals(h, needle));
}

/**
 * Format::htmlchars($var, $sanitize) (class.format.php): ricorsivo sugli array, Format::sanitize
 * se richiesto, poi htmlspecialchars((string) $var, ENT_COMPAT | ENT_HTML401, 'UTF-8', false).
 */
export function htmlchars(v: PhpVal, sanitize = false): PhpVal {
  if (Array.isArray(v)) return v.map((x) => htmlchars(x, sanitize));
  if (isArray(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, htmlchars(x, sanitize)]));
  const s = str(v);
  return htmlChars(sanitize ? sanitizeText(s) : s);
}

/** Format::htmlchars su tutto $vars: le chiavi assenti (null/undefined) restano assenti. */
export function htmlcharsVars(vars: PhpVars, sanitize = false): PhpVars {
  const out: PhpVars = {};
  for (const [k, v] of Object.entries(vars)) out[k] = v === undefined || v === null ? v : htmlchars(v, sanitize);
  return out;
}
