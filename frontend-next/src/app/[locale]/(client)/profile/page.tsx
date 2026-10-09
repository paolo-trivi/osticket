import { getTranslations, setRequestLocale } from "next-intl/server";

import AccountForm from "@/components/portal/AccountForm";
import Alert from "@/components/ui/alert/Alert";
import { redirect } from "@/i18n/navigation";
import { clientResetToken } from "@/server/auth/client-auth";
import { coreConfig } from "@/server/config/config";
import { db } from "@/server/db";
import { AccountStatus } from "@/server/domain/client/identity";
import { configuredLanguages, profileFormValues, renderedContent } from "@/server/domain/client/ui";
import { baseForms } from "@/server/domain/ticket/create-ui";

import { requireClient } from "../guard";

export async function generateMetadata() {
  const t = await getTranslations("portal.account");
  return { title: t("profileTitle") };
}

/**
 * profile.php: dati di contatto modificabili dai clienti, fuso orario, lingua e password. Gli ospiti
 * (accesso da link) tornano al ticket (protezione dalla presa di controllo dell'account, come il PHP).
 */
export default async function ProfilePage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ pwchange?: string; confirmed?: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const sp = await searchParams;
  const client = await requireClient(locale, "/profile", { skipPwCheck: true });
  if (client.guest) redirect({ href: `/tickets/${client.guest.ticketId}`, locale });
  const t = await getTranslations("portal.account");
  const cfg = await coreConfig();
  const [{ user }, values, resetToken] = await Promise.all([baseForms(db(), cfg, "client"), profileFormValues(cfg, client.id), clientResetToken()]);
  const acct = client.account;
  const forced = !!acct && (acct.status & AccountStatus.REQUIRE_PASSWD_RESET) !== 0;
  const resetAllowed = !!acct && !(acct.status & AccountStatus.FORBID_PASSWD_RESET);
  const thanks = sp.confirmed ? await renderedContent(cfg, "registration-thanks") : null;
  const langs = configuredLanguages(cfg).map((code) => ({ code, label: code }));
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-title-sm font-semibold text-gray-800 dark:text-white/90">{t("profileTitle")}</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t("profileSubtitle")}</p>
      </div>
      {thanks && (
        <section className="rounded-2xl border border-success-200 bg-success-25 p-6 dark:border-success-800 dark:bg-success-500/10">
          <h2 className="font-semibold text-gray-800 dark:text-white/90">{thanks.title}</h2>
          <div className="mt-2 text-sm text-gray-600 dark:text-gray-300" dangerouslySetInnerHTML={{ __html: thanks.html }} />
        </section>
      )}
      {(forced || sp.pwchange) && <Alert variant="warning" title={t("pwchangeRequired")} message="" />}
      <AccountForm
        mode="profile"
        userForm={user}
        values={values}
        timezone={acct?.timezone ?? ""}
        lang={acct?.lang ?? ""}
        languages={langs}
        showPassword={resetAllowed}
        requireCurrent={!resetToken}
      />
    </div>
  );
}
