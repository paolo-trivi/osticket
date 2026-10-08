import { getTranslations, setRequestLocale } from "next-intl/server";
import type { ReactNode } from "react";

import AppShell from "@/components/shell/AppShell";

import { agentLogoutAction } from "../actions";
import { requireAgent } from "../guard";
import { agentNav, shellUser } from "../nav";

export const dynamic = "force-dynamic";

export default async function AgentPanelLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const agent = await requireAgent(locale);

  const t = await getTranslations();
  const legacyUrl = process.env.OST_PHP_URL;
  return (
    <AppShell
      sections={await agentNav(agent)}
      homeHref="/agent"
      user={await shellUser(agent)}
      searchHref="/agent/tickets"
      logoutAction={agentLogoutAction}
      menuLinks={[
        { label: t("header.profile"), href: "/agent/profile" },
        ...(legacyUrl ? [{ label: t("common.legacyPanel"), href: `${legacyUrl}/scp/`, external: true }] : []),
      ]}
    >
      {children}
    </AppShell>
  );
}
