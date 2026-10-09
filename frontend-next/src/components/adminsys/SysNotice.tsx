import { getTranslations } from "next-intl/server";

import { Callout } from "./fields";

/** Esito di un'azione di massa passato in query string (?ok=<azione>&n=<num> oppure ?err=<codice>). */
export default async function SysNotice({ sp }: { sp: Record<string, string | undefined> }) {
  const t = await getTranslations("asys.common");
  const e = await getTranslations("asys.errors");
  if (sp.err) return <Callout tone="error">{e.has(sp.err) ? e(sp.err) : t("failed")}</Callout>;
  if (sp.ok === "created") return <Callout tone="success">{t("createdNotice")}</Callout>;
  if (sp.ok) return <Callout tone="success">{t("done", { n: Number(sp.n ?? 0) })}</Callout>;
  return null;
}
