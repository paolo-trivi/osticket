import { getTranslations } from "next-intl/server";

import FlashNotice from "@/components/admin/FlashNotice";

/** Chiave nuova a ogni render del server: un nuovo esito rimonta FlashNotice anche se il testo è uguale. */
let renderSeq = 0;
const nextKey = () => String(++renderSeq);

/**
 * Esito di un'azione di massa passato in query string (?ok=<azione>&n=<num> oppure ?err=<codice>),
 * mostrato una sola volta (FlashNotice): sparisce al submit successivo.
 */
export default async function SysNotice({ sp }: { sp: Record<string, string | undefined> }) {
  const t = await getTranslations("asys.common");
  const e = await getTranslations("asys.errors");
  if (sp.err)
    return (
      <FlashNotice key={nextKey()} tone="error">
        {e.has(sp.err) ? e(sp.err) : t("failed")}
      </FlashNotice>
    );
  if (sp.ok)
    return (
      <FlashNotice key={nextKey()} tone="success">
        {sp.ok === "created" ? t("createdNotice") : t("done", { n: Number(sp.n ?? 0) })}
      </FlashNotice>
    );
  return null;
}
