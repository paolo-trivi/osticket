import "server-only";

import type { getTranslations } from "next-intl/server";

type Translator = Awaited<ReturnType<typeof getTranslations<"admRoles">>>;

/**
 * Etichetta tradotta di un permesso (RolePermission: titolo — descrizione) da admRoles.permLabels,
 * con la chiave del permesso e "_" al posto del punto (ticket.assign → ticket_assign); per i
 * permessi non tradotti (es. registrati da plugin) restano i testi inglesi del PHP.
 */
export function permLabel(t: Translator, p: { key: string; title: string; desc: string }): string {
  const k = `permLabels.${p.key.replace(/\./g, "_")}`;
  return t.has(k as never) ? t(k as never) : `${p.title} — ${p.desc}`;
}
