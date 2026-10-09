import { getTranslations, setRequestLocale } from "next-intl/server";

import LoginPanel from "@/components/portal/LoginPanel";
import { redirect } from "@/i18n/navigation";
import { currentClient } from "@/server/auth/client-auth";
import { coreConfig } from "@/server/config/config";
import { renderedContent } from "@/server/domain/client/ui";

export async function generateMetadata() {
  const t = await getTranslations("portal.login");
  return { title: t("title") };
}

/** login.php / view.php: accesso con account o verifica dello stato del ticket. */
export default async function PortalLoginPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ next?: string; error?: string; e?: string; t?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const sp = await searchParams;
  const client = await currentClient();
  if (client && !client.guest) redirect({ href: "/tickets", locale });
  const cfg = await coreConfig();
  const registration = cfg.str("client_registration");
  return (
    <LoginPanel
      next={sp.next}
      linkError={sp.error}
      showLogin={registration !== "disabled"}
      canRegister={["public", "auto"].includes(registration)}
      verifyEmail={cfg.bool("client_verify_email")}
      canOpen={registration !== "disabled" || !cfg.bool("clients_only")}
      allowReset={cfg.bool("allow_pw_reset")}
      defaults={{ login: sp.e, email: sp.e, number: sp.t }}
      banner={registration !== "disabled" ? await renderedContent(cfg, "banner-client") : null}
    />
  );
}
