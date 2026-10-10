import { getTranslations, setRequestLocale } from "next-intl/server";

import AuthLayout from "@/components/shell/AuthLayout";
import { redirect } from "@/i18n/navigation";
import { sessionAgent } from "@/server/auth/staff-auth";
import { loadTheme } from "@/server/theme/theme";

import LoginForm from "./LoginForm";

export async function generateMetadata() {
  return { title: (await getTranslations("auth"))("agentLoginTitle") };
}

export const dynamic = "force-dynamic";

export default async function AgentLoginPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ next?: string; expired?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { next, expired } = await searchParams;

  if (await sessionAgent()) redirect({ href: "/agent", locale });

  const t = await getTranslations("auth");
  const theme = await loadTheme();
  return (
    <AuthLayout
      sideTitle={theme.displayName}
      sideText={theme.login_tagline || t("sideText")}
      backdropUrl={theme.backdropId ? "/api/branding/backdrop" : undefined}
    >
      <LoginForm next={next} expired={expired === "1"} />
    </AuthLayout>
  );
}
