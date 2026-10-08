import { getTranslations, setRequestLocale } from "next-intl/server";
import type { ReactNode } from "react";

import AppShell from "@/components/shell/AppShell";
import { GridIcon, ListIcon, PieChartIcon } from "@/icons";
import type { NavSection } from "@/layout/nav-types";

import { agentLogoutAction } from "../agent/actions";
import { shellUser } from "../agent/nav";
import { requireAdmin } from "./guard";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const agent = await requireAdmin(locale);
  const t = await getTranslations();

  const sections: NavSection[] = [
    {
      title: t("nav.groups.admin"),
      items: [
        { key: "admin-home", label: t("admin.home"), icon: <GridIcon />, href: "/admin", exact: true },
        {
          key: "settings",
          label: t("nav.items.settings"),
          icon: <ListIcon />,
          children: [{ label: t("admin.theme.title"), href: "/admin/theme" }],
        },
      ],
    },
    {
      title: t("nav.groups.agent"),
      items: [{ key: "agent", label: t("nav.items.agentPanel"), icon: <PieChartIcon />, href: "/agent" }],
    },
  ];

  return (
    <AppShell
      sections={sections}
      homeHref="/admin"
      user={await shellUser(agent)}
      logoutAction={agentLogoutAction}
      menuLinks={[{ label: t("nav.items.agentPanel"), href: "/agent" }]}
    >
      {children}
    </AppShell>
  );
}
