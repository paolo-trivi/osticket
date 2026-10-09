import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import ComponentCard from "@/components/common/ComponentCard";
import ThreadEntryCard from "@/components/tickets/ThreadEntryCard";
import Badge from "@/components/ui/badge/Badge";
import { Link } from "@/i18n/navigation";
import { coreConfig } from "@/server/config/config";
import { db } from "@/server/db";
import { formatAgentName } from "@/server/domain/ticket/rows";
import {
  checkStaffPerm,
  loadCollaborators,
  loadThreadEntries,
  loadThreadEvents,
  loadTicket,
  loadTicketAnswers,
  roleOn,
  type ThreadEntryView,
  type ThreadEventView,
} from "@/server/domain/ticket/ticket";
import { agentTimeZone, formatDbDate } from "@/server/format/datetime";
import { stripTags } from "@/server/format/html";

import { requireAgent } from "../../../guard";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const row = await db().selectFrom("ticket").select("number").where("ticket_id", "=", Number(id)).executeTakeFirst();
  return { title: row ? `#${row.number}` : "Ticket" };
}

function Info({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1.5 text-sm">
      <dt className="text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="text-end text-gray-800 dark:text-white/90">{children || "—"}</dd>
    </div>
  );
}

export default async function TicketViewPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const agent = await requireAgent(locale);
  const ticket = await loadTicket(Number(id), agent.id);
  // Come scp/tickets.php: ticket inesistente o non accessibile → stesso messaggio
  if (!ticket || !(await checkStaffPerm(ticket, agent))) notFound();

  const t = await getTranslations("ticket");
  const te = await getTranslations("events");
  const tz = await agentTimeZone(agent);
  const cfg = await coreConfig();
  const iframeWhitelist = cfg.str("embedded_domain_whitelist").split(/[,\s]+/).filter(Boolean);

  const [entries, events, answers, collaborators] = await Promise.all([
    ticket.thread_id ? loadThreadEntries(ticket.thread_id) : Promise.resolve([] as ThreadEntryView[]),
    ticket.thread_id ? loadThreadEvents(ticket.thread_id) : Promise.resolve([] as ThreadEventView[]),
    loadTicketAnswers(ticket.ticket_id),
    ticket.thread_id ? loadCollaborators(ticket.thread_id) : Promise.resolve([]),
  ]);

  // Nomi degli oggetti citati negli eventi (assegnatari, team, reparti, stati)
  const ids = { staff: new Set<number>(), team: new Set<number>(), dept: new Set<number>(), status: new Set<number>() };
  for (const ev of events) {
    for (const k of ["staff", "team", "dept", "status"] as const) {
      const v = ev.data[k];
      if (typeof v === "number" || (typeof v === "string" && /^\d+$/.test(v))) ids[k].add(Number(v));
    }
  }
  const [staffRows, teamRows, deptRows, statusRows] = await Promise.all([
    ids.staff.size ? db().selectFrom("staff").select(["staff_id", "firstname", "lastname"]).where("staff_id", "in", [...ids.staff]).execute() : [],
    ids.team.size ? db().selectFrom("team").select(["team_id", "name"]).where("team_id", "in", [...ids.team]).execute() : [],
    ids.dept.size ? db().selectFrom("department").select(["id", "name"]).where("id", "in", [...ids.dept]).execute() : [],
    ids.status.size ? db().selectFrom("ticket_status").select(["id", "name"]).where("id", "in", [...ids.status]).execute() : [],
  ]);
  const staffName = new Map<number, string>();
  for (const s of staffRows) staffName.set(s.staff_id, await formatAgentName(s.firstname, s.lastname));
  const teamName = new Map(teamRows.map((r) => [r.team_id, r.name]));
  const deptName = new Map(deptRows.map((r) => [r.id, r.name]));
  const statusName = new Map(statusRows.map((r) => [r.id, r.name]));

  const b = (chunks: ReactNode) => <strong className="font-medium text-gray-700 dark:text-gray-300">{chunks}</strong>;
  const describe = (ev: ThreadEventView): ReactNode => {
    const somebody = ev.username || "SYSTEM";
    const d = ev.data;
    const num = (k: string) => Number(d[k]);
    switch (ev.name) {
      case "created":
        return te.rich("created", { somebody, b });
      case "assigned":
        if (d.staff) return te.rich("assignedStaff", { somebody, target: staffName.get(num("staff")) ?? "", b });
        if (d.team) return te.rich("assignedTeam", { somebody, target: teamName.get(num("team")) ?? "", b });
        if (d.claim) return te.rich("claimed", { somebody, b });
        return te.rich("assigned", { somebody, b });
      case "released":
        return te.rich("released", { somebody, b });
      case "referred":
        if (d.staff) return te.rich("referred", { somebody, target: staffName.get(num("staff")) ?? "", b });
        if (d.team) return te.rich("referred", { somebody, target: teamName.get(num("team")) ?? "", b });
        return te.rich("referred", { somebody, target: deptName.get(num("dept")) ?? "", b });
      case "closed":
        return d.status
          ? te.rich("closedStatus", { somebody, status: statusName.get(num("status")) ?? "", b })
          : te.rich("closed", { somebody, b });
      case "reopened":
        return te.rich("reopened", { somebody, b });
      case "overdue":
        return te("overdue");
      case "transferred":
        return te.rich("transferred", { somebody, target: ev.dept_name ?? "", b });
      case "edited":
        if (d.status) return te.rich("statusChanged", { somebody, status: statusName.get(num("status")) ?? "", b });
        return te.rich("edited", { somebody, b });
      case "collab":
        return te.rich("collab", { somebody, b });
      case "merged":
        return te.rich("merged", { somebody, b });
      case "linked":
        return te.rich("linked", { somebody, b });
      case "resent":
        return te.rich("resent", { somebody, b });
      case "deleted":
        return te.rich("deleted", { somebody, b });
      default:
        return `${ev.name} · ${somebody}`;
    }
  };

  // Timeline: entry ed eventi in ordine cronologico (a parità di istante prima l'evento, es. "Creato")
  const timeline = [...entries, ...events].sort((a, x) => {
    const ta = a.kind === "entry" ? a.created : a.timestamp;
    const tx = x.kind === "entry" ? x.created : x.timestamp;
    if (ta !== tx) return ta < tx ? -1 : 1;
    return a.kind === x.kind ? 0 : a.kind === "event" ? -1 : 1;
  });
  const order = agent.config.str("thread_view_order") || cfg.str("thread_view_order", "ASC");
  if (order === "DESC") timeline.reverse();

  const assignee = ticket.staff_id ? await formatAgentName(ticket.staff_first, ticket.staff_last) : "";
  const role = roleOn(ticket, agent);
  const legacy = process.env.OST_PHP_URL;
  const entryLabels = { note: t("internalNote"), reply: t("reply"), message: t("message"), edited: t("editedBy"), via: t("via") };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href="/agent/tickets" className="text-theme-sm text-gray-500 hover:text-brand-500 dark:text-gray-400">
            ← {t("backToList")}
          </Link>
          <h1 className="mt-1 text-title-sm font-semibold text-gray-800 dark:text-white/90">
            #{ticket.number} · {stripTags(ticket.subject)}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge color={ticket.status_state === "open" ? "success" : "light"}>{ticket.status_name}</Badge>
            {ticket.priority && (
              <span className="inline-flex items-center gap-1.5 text-theme-sm text-gray-600 dark:text-gray-400">
                <span className="size-2.5 rounded-full" style={{ backgroundColor: ticket.priority_color ?? "#ccc" }} />
                {ticket.priority}
              </span>
            )}
            {ticket.isoverdue && <Badge color="error">{t("overdue")}</Badge>}
            {ticket.isanswered && <Badge color="info">{t("answered")}</Badge>}
            {ticket.locked_by_other && <Badge color="warning">🔒 {t("locked")}</Badge>}
          </div>
        </div>
        {legacy && (
          <a
            href={`${legacy}/scp/tickets.php?id=${ticket.ticket_id}`}
            className="rounded-lg border border-gray-200 px-3 py-2 text-theme-sm text-gray-600 hover:bg-gray-50 dark:border-gray-800 dark:text-gray-400 dark:hover:bg-white/5"
          >
            {t("openLegacy")}
          </a>
        )}
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          {timeline.map((item) =>
            item.kind === "entry" ? (
              <ThreadEntryCard key={`e${item.id}`} entry={item} tz={tz} locale={locale} labels={entryLabels} iframeWhitelist={iframeWhitelist} />
            ) : (
              <div key={`v${item.id}`} className="flex items-center gap-3 px-2 text-theme-sm text-gray-500 dark:text-gray-400">
                <span className="size-2 rounded-full bg-gray-300 dark:bg-gray-600" />
                <span>{describe(item)}</span>
                <span className="text-theme-xs text-gray-400">{formatDbDate(item.timestamp, tz, locale, "short")}</span>
              </div>
            ),
          )}
        </div>

        <aside className="space-y-6">
          <ComponentCard title={t("details")}>
            <dl className="divide-y divide-gray-100 dark:divide-gray-800">
              <Info label={t("department")}>{ticket.dept_name}</Info>
              <Info label={t("helpTopic")}>{ticket.topic_name}</Info>
              <Info label={t("sla")}>{ticket.sla_name}</Info>
              <Info label={t("source")}>{ticket.source}</Info>
              <Info label={t("created")}>{formatDbDate(ticket.created, tz, locale)}</Info>
              <Info label={t("dueDate")}>{formatDbDate(ticket.duedate ?? ticket.est_duedate, tz, locale)}</Info>
              <Info label={t("lastMessage")}>{formatDbDate(ticket.lastmessage, tz, locale)}</Info>
              <Info label={t("lastResponse")}>{formatDbDate(ticket.lastresponse, tz, locale)}</Info>
              {ticket.closed && <Info label={t("closed")}>{formatDbDate(ticket.closed, tz, locale)}</Info>}
            </dl>
          </ComponentCard>

          <ComponentCard title={t("user")}>
            <dl className="divide-y divide-gray-100 dark:divide-gray-800">
              <Info label={t("name")}>{ticket.user_name}</Info>
              <Info label={t("email")}>{ticket.user_email}</Info>
              <Info label={t("phone")}>{ticket.user_phone}</Info>
              <Info label={t("organization")}>{ticket.org_name}</Info>
            </dl>
          </ComponentCard>

          <ComponentCard title={t("assignment")}>
            <dl className="divide-y divide-gray-100 dark:divide-gray-800">
              <Info label={t("assignedTo")}>{assignee}</Info>
              <Info label={t("team")}>{ticket.team_name}</Info>
              <Info label={t("yourRole")}>{role.name || t("viewOnly")}</Info>
            </dl>
          </ComponentCard>

          {collaborators.length > 0 && (
            <ComponentCard title={t("collaborators")}>
              <ul className="space-y-1 text-sm">
                {collaborators.map((c) => (
                  <li key={c.id} className={c.active ? "text-gray-800 dark:text-white/90" : "text-gray-400 line-through"}>
                    {c.name} {c.email && <span className="text-gray-500">&lt;{c.email}&gt;</span>}
                  </li>
                ))}
              </ul>
            </ComponentCard>
          )}

          {answers.length > 0 && (
            <ComponentCard title={t("additionalFields")}>
              <dl className="divide-y divide-gray-100 dark:divide-gray-800">
                {answers.map((a) => (
                  <Info key={`${a.form_title}-${a.name}`} label={a.label}>
                    {a.value}
                  </Info>
                ))}
              </dl>
            </ComponentCard>
          )}
        </aside>
      </div>
    </div>
  );
}
