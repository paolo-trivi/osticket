import { getTranslations } from "next-intl/server";

import { DocsIcon, FolderIcon, GridIcon, GroupIcon, ListIcon, PlugInIcon, TaskIcon, UserCircleIcon } from "@/icons";
import type { NavSection, ShellUser } from "@/layout/nav-types";
import { agentQueueNav } from "@/server/domain/queue/context";
import { GlobalPerm, TicketPerm, type Agent } from "@/server/domain/staff/staff";

/** Menu del pannello agenti: stesse condizioni di visibilità della barra di navigazione di scp/. */
export async function agentNav(agent: Agent): Promise<NavSection[]> {
  const t = await getTranslations("nav");
  const tq = await getTranslations("queues");
  const { top, counts } = await agentQueueNav(agent);
  const items: NavSection["items"] = [
    { key: "dashboard", label: t("items.dashboard"), icon: <GridIcon />, href: "/agent", exact: true },
    {
      key: "tickets",
      label: t("items.tickets"),
      icon: <ListIcon />,
      children: [
        ...top.map((q) => {
          const c = counts.get(q.id);
          return {
            label: tq.has(q.title) ? tq(q.title) : q.title,
            href: `/agent/tickets?queue=${q.id}`,
            exact: true,
            badge: typeof c === "number" ? c : undefined,
          };
        }),
        ...(agent.hasPermInAnyRole(TicketPerm.CREATE)
          ? [{ label: t("items.newTicket"), href: "/agent/tickets/new", exact: true }]
          : []),
      ],
    },
    { key: "tasks", label: t("items.tasks"), icon: <TaskIcon />, href: "/agent/tasks" },
  ];

  if (agent.hasGlobalPerm(GlobalPerm.USER_DIR) || agent.isAdmin || agent.hasGlobalPerm(GlobalPerm.USER_EDIT)) {
    items.push({ key: "users", label: t("items.users"), icon: <UserCircleIcon />, href: "/agent/users" });
  }
  items.push({ key: "orgs", label: t("items.organizations"), icon: <GroupIcon />, href: "/agent/orgs" });
  items.push({
    key: "kb",
    label: t("items.kb"),
    icon: <FolderIcon />,
    children: [
      { label: t("items.kb"), href: "/agent/kb" },
      { label: t("items.canned"), href: "/agent/canned" },
    ],
  });

  const sections: NavSection[] = [{ title: t("groups.agent"), items }];
  if (agent.isAdmin) {
    sections.push({
      title: t("groups.admin"),
      items: [{ key: "admin", label: t("items.adminPanel"), icon: <PlugInIcon />, href: "/admin" }],
    });
  }
  sections.push({
    title: t("groups.account"),
    items: [{ key: "profile", label: t("items.profile"), icon: <DocsIcon />, href: "/agent/profile" }],
  });
  return sections;
}

export async function shellUser(agent: Agent): Promise<ShellUser> {
  const t = await getTranslations("header");
  const { first, last, full } = agent.name;
  return {
    name: full || agent.username,
    email: agent.email,
    subtitle: agent.isAdmin ? t("admin") : undefined,
    initials: ((first[0] ?? "") + (last[0] ?? "")).toUpperCase() || agent.username.slice(0, 2).toUpperCase(),
  };
}
