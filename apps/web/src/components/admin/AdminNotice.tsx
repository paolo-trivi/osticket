import { getTranslations } from "next-intl/server";

/** Esito di un'azione di massa passato in query string (?ok=<azione>&n=<num> oppure ?err=<codice>). */
export default async function AdminNotice({ ok, n, err }: { ok?: string; n?: string; err?: string }) {
  const t = await getTranslations("admUi");
  if (err) {
    const e = await getTranslations("admUi.errors");
    return (
      <div className="rounded-lg border border-error-500 bg-error-50 p-4 text-sm text-error-700 dark:border-error-500/30 dark:bg-error-500/15 dark:text-error-400">
        {e.has(err) ? e(err) : t("failed")}
      </div>
    );
  }
  if (ok) {
    return (
      <div className="rounded-lg border border-success-500 bg-success-50 p-4 text-sm text-success-700 dark:border-success-500/30 dark:bg-success-500/15 dark:text-success-400">
        {t("done", { n: Number(n ?? 0) })}
      </div>
    );
  }
  return null;
}
