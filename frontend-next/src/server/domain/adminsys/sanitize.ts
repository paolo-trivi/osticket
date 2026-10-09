import "server-only";

import { sanitizeText } from "../../format/text";

/**
 * Format::sanitize($text, $striptags) per i contenuti salvati dall'area admin. Gli attributi
 * obbligatori di htmLawed (img alt/src, bdo dir) sono aggiunti dal sanitizer condiviso (safeHtml).
 */
export function sanitizeHtml(text: string, striptags = false): string {
  return sanitizeText(text, striptags);
}
