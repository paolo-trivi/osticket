import { getTranslations, setRequestLocale } from "next-intl/server";

import AuthLayout from "@/components/shell/AuthLayout";
import { redirect } from "@/i18n/navigation";
import { currentAgent } from "@/server/auth/staff-auth";

import LoginForm from "./LoginForm";

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

  if (await currentAgent()) redirect({ href: "/agent", locale });

  const t = await getTranslations("auth");
  return (
    <AuthLayout sideTitle={t("sideTitle")} sideText={t("sideText")}>
      <LoginForm next={next} expired={expired === "1"} />
    </AuthLayout>
  );
}
