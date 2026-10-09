import { getTranslations } from "next-intl/server";

import Callout from "@/components/common/Callout";

/** Esito di un'azione di massa passato in query string (?ok=<azione>&n=<num> oppure ?err=<codice>). */
export default async function AdminNotice({ ok, n, err }: { ok?: string; n?: string; err?: string }) {
  const t = await getTranslations("admUi");
  if (err) {
    const e = await getTranslations("admUi.errors");
    return (
      <Callout tone="error">{e.has(err) ? e(err) : t("failed")}</Callout>
    );
  }
  if (ok) {
    return (
      <Callout tone="success">{t("done", { n: Number(n ?? 0) })}</Callout>
    );
  }
  return null;
}
