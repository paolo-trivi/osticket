/**
 * Utility di formattazione equivalenti a quelle di include/class.format.php.
 * La sanitizzazione completa dell'HTML (Format::safe_html / htmLawed) è in ./sanitize.ts.
 */

const DECODE_MAP: Record<string, string> = {
  "&amp;": "&",
  "&quot;": '"',
  "&lt;": "<",
  "&gt;": ">",
};

/** htmlspecialchars_decode($s, ENT_COMPAT | ENT_HTML401): gli apici singoli restano codificati. */
export function htmlDecode(value: string): string {
  return value.replace(/&(amp|quot|lt|gt);/g, (m) => DECODE_MAP[m] ?? m);
}

/** htmlspecialchars($s, ENT_QUOTES): uso in output. */
export function htmlChars(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * strip_tags() di PHP: rimuove tag HTML, commenti e tag PHP. Un "<" non seguito da un nome di
 * tag valido viene comunque trattato come inizio tag da PHP; qui si replica il caso comune.
 */
export function phpStripTags(value: string): string {
  return value
    .replace(/<!--[\s\S]*?(-->|$)/g, "")
    .replace(/<\?[\s\S]*?(\?>|$)/g, "")
    .replace(/<\/?[a-zA-Z!][^>]*(>|$)/g, "");
}

/** Format::striptags($var, $decode=true). */
export function stripTags(value: string, decode = true): string {
  return phpStripTags(decode ? htmlDecode(value) : value);
}

/**
 * Le tabelle osTicket sono utf8 (3 byte): i caratteri fuori dal BMP (emoji ecc.) non sono
 * memorizzabili e con SQL_MODE='' verrebbero troncati. Il PHP li elimina (Format::strip_emoticons
 * nel percorso HTML); qui si eliminano tutti i caratteri a 4 byte prima di ogni scrittura testuale.
 */
export function stripFourByteChars(value: string): string {
  return value.replace(/[\u{10000}-\u{10FFFF}]/gu, "");
}
