import { getTranslations, setRequestLocale } from "next-intl/server";
import type { ReactNode } from "react";

import AppShell from "@/components/shell/AppShell";
import { BoxCubeIcon, GridIcon, GroupIcon, ListIcon, MailIcon, PieChartIcon } from "@/icons";
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

  const n = await getTranslations("adminNav");
  const link = (key: string, href: string) => ({ label: n(key), href });
  // Struttura del menu Admin di scp/ (doc 11): ogni voce punta alla relativa pagina in /admin
  const sections: NavSection[] = [
    {
      title: t("nav.groups.admin"),
      items: [
        { key: "admin-home", label: t("admin.home"), icon: <GridIcon />, href: "/admin", exact: true },
        {
          key: "dashboard",
          label: n("dashboard"),
          icon: <PieChartIcon />,
          children: [link("logs", "/admin/logs"), link("system", "/admin/system")],
        },
        {
          key: "settings",
          label: t("nav.items.settings"),
          icon: <ListIcon />,
          children: [
            link("company", "/admin/settings/company"),
            link("systemSettings", "/admin/settings/system"),
            link("ticketsSettings", "/admin/settings/tickets"),
            link("tasksSettings", "/admin/settings/tasks"),
            link("agentsSettings", "/admin/settings/agents"),
            link("usersSettings", "/admin/settings/users"),
            link("kbSettings", "/admin/settings/kb"),
            { label: t("admin.theme.title"), href: "/admin/theme" },
          ],
        },
        {
          key: "manage",
          label: n("manage"),
          icon: <BoxCubeIcon />,
          children: [
            link("topics", "/admin/topics"),
            link("filters", "/admin/filters"),
            link("sla", "/admin/sla"),
            link("schedules", "/admin/schedules"),
            link("apikeys", "/admin/apikeys"),
            link("pages", "/admin/pages"),
            link("forms", "/admin/forms"),
            link("lists", "/admin/lists"),
            link("queues", "/admin/queues"),
            link("plugins", "/admin/plugins"),
          ],
        },
        {
          key: "emails",
          label: n("emails"),
          icon: <MailIcon />,
          children: [
            link("emailAccounts", "/admin/emails"),
            link("emailSettings", "/admin/settings/emails"),
            link("banlist", "/admin/banlist"),
            link("templates", "/admin/templates"),
            link("diagnostic", "/admin/emails/diagnostic"),
          ],
        },
        {
          key: "staff",
          label: n("agents"),
          icon: <GroupIcon />,
          children: [
            link("agentsList", "/admin/agents"),
            link("teams", "/admin/teams"),
            link("roles", "/admin/roles"),
            link("departments", "/admin/departments"),
          ],
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
