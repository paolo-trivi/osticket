import { Boxes, ChartPie, Headset, LayoutDashboard, Mail, SlidersHorizontal, UserCog } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import type { ReactNode } from "react";

import AppShell from "@/components/shell/AppShell";
import WriteModeBanner from "@/components/shell/WriteModeBanner";
import { WriteModeProvider } from "@/context/WriteModeContext";
import type { NavSection } from "@/layout/nav-types";
import { uiWriteMode } from "@/server/system/write-mode-ui";

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
        {
          key: "admin-home",
          label: t("admin.home"),
          icon: <LayoutDashboard />,
          href: "/admin",
          exact: true,
        },
        {
          key: "dashboard",
          label: n("dashboard"),
          icon: <ChartPie />,
          children: [link("logs", "/admin/logs"), link("system", "/admin/system")],
        },
        {
          key: "settings",
          label: t("nav.items.settings"),
          icon: <SlidersHorizontal />,
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
          icon: <Boxes />,
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
          icon: <Mail />,
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
          icon: <UserCog />,
          children: [link("agentsList", "/admin/agents"), link("teams", "/admin/teams"), link("roles", "/admin/roles"), link("departments", "/admin/departments")],
        },
      ],
    },
    {
      title: t("nav.groups.agent"),
      items: [
        {
          key: "agent",
          label: t("nav.items.agentPanel"),
          icon: <Headset />,
          href: "/agent",
        },
      ],
    },
  ];

  // modalità di scrittura effettiva: l'amministrazione scrive solo in modalità completa
  const wm = await uiWriteMode();
  return (
    <WriteModeProvider configured={wm.configured} effective={wm.effective} reasons={wm.reasons}>
      <AppShell
        sections={sections}
        homeHref="/admin"
        user={await shellUser(agent)}
        logoutAction={agentLogoutAction}
        menuLinks={[{ label: t("nav.items.agentPanel"), href: "/agent" }]}
        banner={<WriteModeBanner area="admin" legacyUrl={process.env.OST_PHP_URL} />}
      >
        {children}
      </AppShell>
    </WriteModeProvider>
  );
}
