import { getTranslations } from "next-intl/server";

import FlashNotice from "./FlashNotice";
import NoticeUndo from "./NoticeUndo";

/** Chiave nuova a ogni render del server: un nuovo esito rimonta FlashNotice anche se il testo è uguale. */
let renderSeq = 0;
const nextKey = () => String(++renderSeq);

/**
 * Esito di un'azione passato in query string: ?ok=<azione>&n=<num> (azioni di massa), ?ok=created dopo una
 * creazione, ?ok=entry dopo l'aggiunta di una voce, ?ok=undone dopo l'annullamento di una modifica, oppure
 * ?err=<codice>; con ?cs=<id> il pulsante "Annulla modifica" (NoticeUndo). Mostrato una sola volta
 * (FlashNotice): sparisce al submit successivo, così non si somma all'esito del nuovo salvataggio.
 */
export default async function AdminNotice({ ok, n, err, cs }: { ok?: string; n?: string; err?: string; cs?: string }) {
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
    const text = ok === "created" ? t("created") : ok === "entry" ? t("entryAdded") : ok === "undone" ? (await getTranslations("admChanges"))("undone") : t("done", { n: Number(n ?? 0) });
    return (
      <FlashNotice key={nextKey()} tone="success">
        {text}
        <NoticeUndo cs={cs} leave={ok === "created"} />
      </FlashNotice>
    );
  }
  return null;
}
