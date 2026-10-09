import "server-only";

import { sanitizeText } from "../../format/text";

/**
 * Format::sanitize($text, $striptags) con gli attributi obbligatori aggiunti da htmLawed
 * ($requiredAttrAr di include/htmLawed.php): un <img> senza alt riceve alt="image" (e senza src
 * src="src"), un <bdo> senza dir riceve dir="ltr". Il sanitizer condiviso (format/sanitize.ts) non lo
 * fa: qui si completa l'output per i contenuti salvati dall'area admin.
 * TODO coordinatore: spostare questa regola in safeHtml.
 */
export function sanitizeHtml(text: string, striptags = false): string {
  const clean = sanitizeText(text, striptags);
  if (striptags) return clean;
  return clean
    .replace(/<img\b((?:"[^"]*"|'[^']*'|[^'">])*?)\s*(\/?)>/gi, (_m, attrs: string, slash: string) => {
      let a = attrs;
      if (!/\ssrc\s*=/i.test(a)) a += ' src="src"';
      if (!/\salt\s*=/i.test(a)) a += ' alt="image"';
      return `<img${a}${slash ? " /" : ""}>`;
    })
    .replace(/<bdo\b((?:"[^"]*"|'[^']*'|[^'">])*?)>/gi, (m, attrs: string) => (/\sdir\s*=/i.test(attrs) ? m : `<bdo${attrs} dir="ltr">`));
}
