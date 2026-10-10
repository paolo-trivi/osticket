import { getTranslations, setRequestLocale } from "next-intl/server";

import { MfaVerifyForm } from "@/components/people/auth/RecoveryForms";
import AuthLayout from "@/components/shell/AuthLayout";
import { redirect } from "@/i18n/navigation";
import { pendingMfaSession } from "@/server/auth/staff-recovery";
import { loadTheme } from "@/server/theme/theme";

export async function generateMetadata() {
  return { title: (await getTranslations("auth"))("agentLoginTitle") };
}

export const dynamic = "force-dynamic";

/** Secondo passo del login con 2FA via email (scp/login.php con sessione 2FA pendente). */
export default async function AgentMfaPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ next?: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { next } = await searchParams;
  if (!(await pendingMfaSession())) redirect({ href: "/agent/login", locale });
  const t = await getTranslations("auth");
  const theme = await loadTheme();
  return (
    <AuthLayout sideTitle={theme.displayName} sideText={theme.login_tagline || t("sideText")} backdropUrl={theme.backdropId ? "/api/branding/backdrop" : undefined}>
      <MfaVerifyForm next={next} />
    </AuthLayout>
  );
}
