import { decodeHtml401Entities, htmlChars, htmlDecode, phpStripTags } from "./html";
import { safeHtml } from "./sanitize";

/**
 * Trasformazioni testuali applicate dal PHP prima di salvare contenuti (include/class.format.php,
 * include/class.thread.php ThreadEntryBody).
 */

const EMOTICON_RANGES: [number, number][] = [
  [0x1f601, 0x1f64f], [0x1f680, 0x1f6c0], [0x1f600, 0x1f636], [0x1f681, 0x1f6c5], [0x1f30d, 0x1f567],
  [0x1f910, 0x1f999], [0x1f9d0, 0x1f9df], [0x1f9e0, 0x1f9ef], [0x1f6f0, 0x1f6ff], [0x1f6e0, 0x1f6ef],
  [0x1f6c0, 0x1f6cf], [0x1f9c0, 0x1f9c2], [0x1f6d0, 0x1f6d2], [0x1f500, 0x1f5ff], [0x1f300, 0x1f3ff],
  [0x2702, 0x27b0], [0x00a9, 0x00ae], [0x23f0, 0x23ff], [0x23e0, 0x23ef], [0x2310, 0x231f],
  [0x1000b6, 0x1000b6], [0x2322, 0x232f], [0x00b0, 0x00b0], [0x00ba, 0x00ba],
];

/** Format::strip_emoticons */
export function stripEmoticons(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (!EMOTICON_RANGES.some(([a, b]) => cp >= a && cp <= b)) out += ch;
  }
  return out;
}

/** Format::editor_spacing */
export function editorSpacing(text: string): string {
  return text.replace(/<p><\/p>/g, "<p><br></p>");
}

/** Format::localizeInlineImages: URL file.php → cid:<key> */
export function localizeInlineImages(text: string): string {
  return text.replace(
    /<img src="(?:https?:\/)?(?:\/[^/"]+)*?\/file\.php\?(?:\w+=[^&"]+&(?:amp;)?)*?key=([^&]+)[^"]*/g,
    '<img src="cid:$1',
  );
}

/** Format::sanitize($text, $striptags) */
export function sanitizeText(text: string, striptags = false): string {
  const clean = safeHtml(localizeInlineImages(text));
  return striptags ? phpStripTags(clean) : clean;
}

/** Format::stripExternalImages($input, $display=false) */
function stripExternalImages(input: string, allowExternal: boolean, display = false): string {
  const allowed = ["gif", "png", "jpg", "jpeg"];
  return input.replace(/<img\b([^>]*?)\bsrc\s*=\s*(["'])(.*?)\2([^>]*)\/?>/gi, (m, _a, _q, src: string) => {
    const local = src.trimStart().toLowerCase().startsWith("cid:");
    let path = "";
    try {
      path = new URL(src, "http://x/").pathname;
    } catch {
      path = src;
    }
    const parts = path.split(".");
    const ext = (parts[parts.length - 1] ?? "").split(/[^A-Za-z]/)[0];
    if (!local && ((!allowExternal && display) || !allowed.includes(ext))) return "";
    return m;
  });
}

/** Format::stripEmptyLines */
export function stripEmptyLines(text: string): string {
  return text.trim().replace(/\n{3,}/g, "\n\n");
}

/** Format::searchable (normalizzazione NFC, spazi multipli, trim) */
export function searchable(text: string): string {
  return text.normalize("NFC").replace(/(\s)\s+/gu, "$1").trim();
}

/** HtmlThreadEntryBody::getSearchable: i tag diventano spazi, entità decodificate. */
export function htmlSearchable(html: string): string {
  let body = html.replace(/<!--[\s\S]*?-->/g, "");
  body = body.replace(/<\/?([a-zA-Z][\w:-]*)\b[^>]*>/g, (_m, el: string) => (el.toLowerCase() === "wbr" ? "" : " "));
  body = htmlDecode(body).replace(/\s+/gu, " ");
  return searchable(body);
}

/** trim() di PHP con lista di caratteri. */
export function phpTrim(value: string, chars = " \t\n\r\0\x0B"): string {
  let s = 0;
  let e = value.length;
  while (s < e && chars.includes(value[s])) s++;
  while (e > s && chars.includes(value[e - 1])) e--;
  return value.slice(s, e);
}

export type BodyFormat = "html" | "text";

/**
 * Corpo pronto per thread_entry.body come ThreadEntry::create (getClean, emoticon, '-' se vuoto,
 * immagini esterne). `byUser` = c'è un agente o un cliente autenticato (editor_spacing).
 */
export function cleanEntryBody(body: string, format: BodyFormat, opts: { allowExternalImages: boolean; byUser: boolean }): string {
  let clean: string;
  if (format === "html") {
    let b = phpTrim(body, " <>br/\t\n\r") ? body : "";
    if (opts.byUser) b = editorSpacing(b);
    clean = sanitizeText(b);
  } else {
    const b = body.trim() ? body : "";
    // TextThreadEntryBody::getClean: htmlchars(html_balance(stripEmptyLines(…))). Di html_balance si
    // replica la decodifica delle entità; la chiusura dei tag sbilanciati (DOM di libxml) no.
    clean = htmlChars(decodeHtml401Entities(stripEmptyLines(b)));
  }
  clean = stripEmoticons(clean) || "-";
  return stripExternalImages(clean, opts.allowExternalImages);
}

/** Testo indicizzabile del corpo salvato. */
export function bodySearchable(body: string, format: BodyFormat): string {
  return format === "html" ? htmlSearchable(body) : searchable(body);
}
