import { getTranslations, setRequestLocale } from "next-intl/server";

import AccountForm from "@/components/portal/AccountForm";
import { redirect } from "@/i18n/navigation";
import { currentClient } from "@/server/auth/client-auth";
import { coreConfig } from "@/server/config/config";
import { db } from "@/server/db";
import { renderedContent } from "@/server/domain/client/ui";
import { baseForms } from "@/server/domain/ticket/create-ui";

export async function generateMetadata() {
  const t = await getTranslations("portal.account");
  return { title: t("registerTitle") };
}

/** account.php: registrazione (client_registration public/auto); un ospite registra il proprio utente. */
export default async function RegisterPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const cfg = await coreConfig();
  if (!["public", "auto"].includes(cfg.str("client_registration"))) redirect({ href: "/", locale });
  const client = await currentClient();
  if (client && !client.guest) redirect({ href: "/profile", locale });
  const t = await getTranslations("portal.account");
  const { user } = await baseForms(db(), cfg, "client");
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-title-sm font-semibold text-gray-800 dark:text-white/90">{t("registerTitle")}</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t("registerSubtitle")}</p>
      </div>
      <AccountForm
        mode="register"
        userForm={user}
        values={{}}
        timezone=""
        languages={[]}
        showPassword
        requireCurrent={false}
        lockEmail={!!client?.guest}
        doneContent={await renderedContent(cfg, "registration-confirm")}
      />
    </div>
  );
}
