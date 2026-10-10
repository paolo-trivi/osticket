import { getTranslations } from "next-intl/server";

import FlashNotice from "./FlashNotice";

/** Chiave nuova a ogni render del server: un nuovo esito rimonta FlashNotice anche se il testo è uguale. */
let renderSeq = 0;
const nextKey = () => String(++renderSeq);

/**
 * Esito di un'azione passato in query string: ?ok=<azione>&n=<num> (azioni di massa), ?ok=created dopo una
 * creazione, ?ok=entry dopo l'aggiunta di una voce, oppure ?err=<codice>. Mostrato una sola volta
 * (FlashNotice): sparisce al submit successivo, così non si somma all'esito del nuovo salvataggio.
 */
export default async function AdminNotice({ ok, n, err }: { ok?: string; n?: string; err?: string }) {
  const t = await getTranslations("admUi");
  if (err) {
    const e = await getTranslations("admUi.errors");
    return (
      <FlashNotice key={nextKey()} tone="error">
        {e.has(err) ? e(err) : t("failed")}
      </FlashNotice>
    );
  }
  if (ok) {
    return (
      <FlashNotice key={nextKey()} tone="success">
        {ok === "created" ? t("created") : ok === "entry" ? t("entryAdded") : t("done", { n: Number(n ?? 0) })}
      </FlashNotice>
    );
  }
  return null;
}
