import { BookOpen, Building, Inbox, LayoutDashboard, ListChecks, Settings, SquareKanban, UserRound, Users } from "lucide-react";
import { getTranslations } from "next-intl/server";

import type { NavSection, ShellUser } from "@/layout/nav-types";
import { agentQueueNav, defaultQueueId } from "@/server/domain/queue/context";
import type { TicketQueue } from "@/server/domain/queue/queues";
import { GlobalPerm, TicketPerm, type Agent } from "@/server/domain/staff/staff";

/**
 * Menu del pannello agenti: stesse condizioni di visibilità della barra di navigazione di scp/.
 * In sola lettura (`writable` falso) manca "Nuovo ticket".
 */
export async function agentNav(agent: Agent, writable = true): Promise<NavSection[]> {
  const t = await getTranslations("nav");
  const tq = await getTranslations("queues");
  const { all, queues, top, counts } = await agentQueueNav(agent);
  // Coda mostrata da /agent/tickets senza ?queue (stessa scelta della lista): preferenza agente o di sistema, poi 1
  const wanted = await defaultQueueId(agent);
  const defaultId = all.has(wanted) ? wanted : 1;
  const navigable = new Set(queues.map((q) => q.id));
  // Sotto-code navigabili (a qualunque livello): attivano la voce della coda principale
  const descendants = (q: TicketQueue): number[] => q.children.filter((c) => navigable.has(c.id)).flatMap((c) => [c.id, ...descendants(c)]);
  const items: NavSection["items"] = [
    {
      key: "dashboard",
      label: t("items.dashboard"),
      icon: <LayoutDashboard />,
      href: "/agent",
      exact: true,
    },
    {
      key: "tickets",
      label: t("items.tickets"),
      icon: <Inbox />,
      area: "/agent/tickets",
      children: [
        ...top.map((q) => {
          const c = counts.get(q.id);
          const subs = descendants(q);
          return {
            label: tq.has(q.title) ? tq(q.title) : q.title,
            href: `/agent/tickets?queue=${q.id}`,
            exact: true,
            badge: typeof c === "number" ? c : undefined,
            alias: subs.map((id) => `/agent/tickets?queue=${id}`),
            // senza parametri la lista mostra la coda predefinita (anche dopo un'azione: ?done=…)
            fallbackUnless: q.id === defaultId || subs.includes(defaultId) ? ["queue", "q", "user", "org"] : undefined,
          };
        }),
        ...(writable && agent.hasPermInAnyRole(TicketPerm.CREATE)
          ? [
              {
                label: t("items.newTicket"),
                href: "/agent/tickets/new",
                exact: true,
              },
            ]
          : []),
      ],
    },
    {
      key: "board",
      label: t("items.board"),
      icon: <SquareKanban />,
      href: "/agent/board",
    },
    {
      key: "tasks",
      label: t("items.tasks"),
      icon: <ListChecks />,
      href: "/agent/tasks",
    },
  ];

  if (agent.hasGlobalPerm(GlobalPerm.USER_DIR) || agent.isAdmin || agent.hasGlobalPerm(GlobalPerm.USER_EDIT)) {
    items.push({
      key: "users",
      label: t("items.users"),
      icon: <Users />,
      href: "/agent/users",
    });
  }
  items.push({
    key: "orgs",
    label: t("items.organizations"),
    icon: <Building />,
    href: "/agent/orgs",
  });
  items.push({
    key: "kb",
    label: t("items.kb"),
    icon: <BookOpen />,
    children: [
      { label: t("items.kb"), href: "/agent/kb" },
      { label: t("items.canned"), href: "/agent/canned" },
    ],
  });

  const sections: NavSection[] = [{ title: t("groups.agent"), items }];
  if (agent.isAdmin) {
    sections.push({
      title: t("groups.admin"),
      items: [
        {
          key: "admin",
          label: t("items.adminPanel"),
          icon: <Settings />,
          href: "/admin",
        },
      ],
    });
  }
  sections.push({
    title: t("groups.account"),
    items: [
      {
        key: "profile",
        label: t("items.profile"),
        icon: <UserRound />,
        href: "/agent/profile",
      },
    ],
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
