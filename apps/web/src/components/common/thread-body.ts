import { inlineCidImages, type FileArea } from "@/lib/format/inline-images";
import type { ThreadEntryView } from "@/server/domain/ticket/ticket";
import { safeHtml, textToHtml } from "@/server/format/sanitize";

/**
 * Corpo HTML di una voce del thread: HTML ri-sanificato (iframe solo dai domini di `iframeWhitelist`),
 * immagini inline cid:<chiave> servite dalla route protetta dei file dell'area (agenti o portale).
 */
export function renderThreadBody(entry: Pick<ThreadEntryView, "format" | "body">, opts: { area: FileArea; iframeWhitelist?: string[] }): string {
  const html = entry.format === "html" ? entry.body : textToHtml(entry.body);
  return inlineCidImages(safeHtml(html, { iframeWhitelist: opts.iframeWhitelist, decode: false }), opts.area);
}
