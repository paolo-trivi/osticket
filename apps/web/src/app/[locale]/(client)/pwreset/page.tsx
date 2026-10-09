import { getTranslations, setRequestLocale } from "next-intl/server";

import ResetForms from "@/components/portal/ResetForms";
import { redirect } from "@/i18n/navigation";
import { coreConfig } from "@/server/config/config";
import { db } from "@/server/db";

export async function generateMetadata() {
  const t = await getTranslations("portal.pwreset");
  return { title: t("title") };
}

/**
 * pwreset.php: senza token richiesta del link; con il token di un account da confermare si passa
 * alla conferma (route handler /pwreset/confirm), altrimenti si chiede di nuovo il nome utente.
 */
export default async function PwresetPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ token?: string; form?: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { token, form } = await searchParams;
  const t = await getTranslations("portal.pwreset");
  const cfg = await coreConfig();
  if (token && !form) {
    const row = await db().selectFrom("config").select("value").where("namespace", "=", "pwreset").where("key", "=", token).executeTakeFirst();
    if (!row) redirect({ href: "/", locale });
    redirect({ href: `/pwreset/confirm?token=${encodeURIComponent(token)}`, locale });
  }
  return (
    <div className="space-y-6">
      <h1 className="text-title-sm font-semibold text-gray-800 dark:text-white/90">{t("title")}</h1>
      {!token && !cfg.bool("allow_pw_reset") ? <p className="text-sm text-gray-500 dark:text-gray-400">{t("disabled")}</p> : <ResetForms token={token} />}
    </div>
  );
}
