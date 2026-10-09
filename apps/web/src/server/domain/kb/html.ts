import "server-only";

import { withBase } from "@/lib/base-path";

import { safeHtml } from "../../format/sanitize";

/** URL di download (route protetta degli agenti) di un file identificato dalla chiave. */
export function agentFileUrl(key: string, inline = false): string {
  return `${withBase(`/api/agent/file/${encodeURIComponent(key)}`)}${inline ? "?disposition=inline" : ""}`;
}

/**
 * HTML di FAQ, categorie e risposte predefinite pronto per la pagina: ri-sanitizzato come
 * Format::safe_html e con le immagini inline `cid:<chiave file>` risolte verso la route protetta
 * (Format::viewableImages / getLocalAnswerWithImages). La route verifica che l'agente possa vedere
 * almeno un oggetto a cui il file è allegato.
 */
export function kbDisplayHtml(html: string | null | undefined): string {
  if (!html) return "";
  return safeHtml(html, { decode: false }).replace(/src="cid:([\w.-]+)"/g, (_m, key: string) => `src="${agentFileUrl(key, true)}"`);
}
