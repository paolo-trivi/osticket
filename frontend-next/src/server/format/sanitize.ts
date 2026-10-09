import sanitizeHtml from "sanitize-html";

import { htmlDecode } from "./html";

/**
 * Equivalente di Format::safe_html() (include/class.format.php, htmLawed):
 * - elimina head/style/script, commenti condizionali, DOCTYPE, PI XML, posizionamenti CSS, spazi unicode;
 * - "safe": niente applet/embed/iframe/object/script (iframe solo dai domini consentiti);
 * - niente form/input/button;
 * - attributi vietati: id, formaction, action, srcset, data-*, on*;
 * - schemi URL consentiti: href (http, https, mailto, ftp, ...), src (cid, http, https, data);
 * - classi CSS: solo quelle che iniziano per "Mso"; stili: niente url(), proprietà duplicate o -vendor/mso-.
 * Il risultato è semanticamente equivalente (stessi tag e attributi ammessi); la serializzazione può
 * differire byte per byte da htmLawed.
 */
const HREF_SCHEMES = ["aim", "feed", "file", "ftp", "gopher", "http", "https", "irc", "mailto", "news", "nntp", "sftp", "ssh", "telnet"];

function cleanStyle(style: string): string | null {
  const props = new Set<string>();
  const out: string[] = [];
  for (const raw of htmlDecode(style).split(/;\s*/)) {
    const idx = raw.indexOf(":");
    if (idx < 0) continue;
    const prop = raw.slice(0, idx).trim();
    let val = raw.slice(idx + 1);
    if (/\burl\s*\(/i.test(val)) continue;
    if (props.has(prop)) continue;
    props.add(prop);
    if (!val.trim() || !prop || prop[0] === "-" || prop.startsWith("mso-")) continue;
    val = val.indexOf(" ") <= 0 ? val.replace(/"/g, "") : val.replace(/"/g, "'");
    out.push(`${prop}:${val.trim()}`);
  }
  return out.length ? out.join(";") : null;
}

export function safeHtml(input: string, options: { iframeWhitelist?: string[]; decode?: boolean } = {}): string {
  let html = options.decode === false ? input : htmlDecode(input);
  html = html
    .replace(/<(head|style|script).+?<\/\1>/gis, "")
    .replace(/<!\[[^\]<]+\]>/g, "")
    .replace(/<!DOCTYPE[^>]+>/g, "")
    .replace(/<\?[^>]+>/g, "")
    .replace(/<html[^>]+/gi, "<html")
    .replace(/<(a|span) (name|style)="(mso-bookmark:)?_MailEndCompose">(.+)?<\/(a|span)>/g, "$4")
    .replace(/<div dir=(3D)?"ltr">(.*?)<\/div>(.*)/gis, "$2 $3")
    .replace(/position: ?(-webkit-)?(static|relative|fixed|absolute|sticky|initial|inherit);?/g, "")
    .replace(/[ -​]+/gu, " ");

  const whitelist = options.iframeWhitelist ?? [];
  const iframeRe = whitelist.length
    ? new RegExp(
        `^(https?:)?//(www\\.)?(${whitelist.map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(\\?|/|#)([^@]*)$`,
        "i",
      )
    : null;

  return sanitizeHtml(html, {
    allowedTags: [
      ...sanitizeHtml.defaults.allowedTags.filter((t) => !["form", "input", "button"].includes(t)),
      "img", "span", "font", "center", "u", "s", "strike", "del", "ins", "sub", "sup", "big", "small", "hr", "br",
      "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col",
      ...(iframeRe ? ["iframe"] : []),
    ],
    allowedAttributes: {
      "*": ["class", "style", "title", "lang", "dir", "align", "valign", "width", "height", "border", "cellpadding", "cellspacing", "bgcolor", "color", "face", "size", "colspan", "rowspan", "alt", "name"],
      a: ["href", "target", "rel"],
      img: ["src", "alt", "width", "height"],
      iframe: ["src", "height", "width", "type", "style", "frameborder", "allowfullscreen"],
    },
    allowedSchemes: [],
    allowedSchemesByTag: { a: HREF_SCHEMES, img: ["cid", "http", "https", "data"], iframe: ["http", "https"] },
    allowedSchemesAppliedToAttributes: ["href", "src", "cite"],
    allowProtocolRelative: true,
    disallowedTagsMode: "discard",
    exclusiveFilter: (frame) =>
      (frame.tag === "iframe" && (!frame.attribs.src || !iframeRe?.test(frame.attribs.src))) ||
      (frame.tag === "embed" && !frame.attribs.src),
    transformTags: {
      "*": (tagName, attribs) => {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(attribs)) {
          if (k === "id" || k === "formaction" || k === "action" || k === "srcset" || k.startsWith("data") || k.startsWith("on")) continue;
          if (k === "class") {
            const mso = v.split(" ").filter((c) => c.startsWith("Mso"));
            if (mso.length) out.class = mso.join(" ");
            continue;
          }
          if (k === "style") {
            const st = cleanStyle(v);
            if (st) out.style = st;
            continue;
          }
          out[k] = v;
        }
        return { tagName, attribs: out };
      },
    },
  });
}

/** Testo semplice → HTML come ThreadEntryBody "text" (escape + a capo). */
export function textToHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r?\n/g, "<br />");
}
