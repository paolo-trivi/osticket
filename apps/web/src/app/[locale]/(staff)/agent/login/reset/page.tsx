import { getTranslations, setRequestLocale } from "next-intl/server";

import { ResetForms } from "@/components/people/auth/RecoveryForms";
import AuthLayout from "@/components/shell/AuthLayout";
import { redirect } from "@/i18n/navigation";
import { coreConfig } from "@/server/config/config";
import { staffIdForResetToken } from "@/server/domain/staff/password-reset";
import { db } from "@/server/db";
import { loadTheme } from "@/server/theme/theme";

export const dynamic = "force-dynamic";

/**
 * scp/pwreset.php: senza token richiesta del link (se allow_pw_reset), con token valido form di login
 * con nome utente/email; token sconosciuto → ritorno al login.
 */
export default async function AgentResetPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ token?: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { token } = await searchParams;
  const cfg = await coreConfig();
  if (token) {
    if (!(await staffIdForResetToken(db(), token))) redirect({ href: "/agent/login", locale });
  } else if (!cfg.bool("allow_pw_reset")) redirect({ href: "/agent/login", locale });
  const t = await getTranslations("auth");
  const theme = await loadTheme();
  return (
    <AuthLayout sideTitle={theme.displayName} sideText={theme.login_tagline || t("sideText")} backdropUrl={theme.backdropId ? "/api/branding/backdrop" : undefined}>
      <ResetForms token={token} />
    </AuthLayout>
  );
}
