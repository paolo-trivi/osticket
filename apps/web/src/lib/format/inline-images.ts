import { withBase } from "@/lib/base-path";

/** Route protette che servono i file: pannello agenti o portale clienti. */
export type FileArea = "agent" | "portal";

/** Immagini inline `cid:<chiave>` dell'HTML servite dalla route protetta dei file dell'area indicata. */
export function inlineCidImages(html: string, area: FileArea): string {
  return html.replace(/src="cid:([A-Za-z0-9_-]+)"/g, (_, key: string) => `src="${withBase(`/api/${area}/file/${key}`)}?disposition=inline"`);
}
