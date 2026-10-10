import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import ComponentCard from "@/components/common/ComponentCard";
import TicketActionsMenu from "@/components/tickets/TicketActionsMenu";
import TicketComposer, { type ComposerLabels } from "@/components/tickets/TicketComposer";
import TicketExtraActions from "@/components/tickets/TicketExtraActions";
import ThreadEntryCard from "@/components/tickets/ThreadEntryCard";
import Badge from "@/components/ui/badge/Badge";
import { Link } from "@/i18n/navigation";
import { TaskModel, ThreadEntry, TicketStatus } from "@/lib/osticket/flags";
import { ObjectType } from "@/lib/osticket/object-types";
import { coreConfig } from "@/server/config/config";
import { db } from "@/server/db";
import { listCanned } from "@/server/domain/kb/kb";
import { listTasks } from "@/server/domain/task/tasks";
import { TicketPerm } from "@/server/domain/staff/staff";
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
    // Thread::getEntries() esclude le voci nascoste (versioni precedenti di una voce modificata)
    ticket.thread_id ? loadThreadEntries(ticket.thread_id).then((l) => l.filter((e) => !(e.flags & ThreadEntry.HIDDEN))) : Promise.resolve([] as ThreadEntryView[]),
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

  // Composer: stati ammessi (aperti; chiusi solo con permesso di chiusura), firma, risposte predefinite
  const tc = await getTranslations("composer");
  // scheda "Task" della vista ticket (ticket-view.inc.php): task collegati al ticket
  const taskRow = await db()
    .selectFrom("task")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("object_type", "=", ObjectType.TICKET)
    .where("object_id", "=", ticket.ticket_id)
    .executeTakeFirst();
  const taskCount = Number(taskRow?.n ?? 0);
  const [{ rows: ticketTasks }, tTask, tSource] = await Promise.all([
    taskCount ? listTasks(agent, { queue: "open", ticketId: ticket.ticket_id, page: 1, pageSize: 50 }) : Promise.resolve({ rows: [], total: 0 }),
    getTranslations("tasks"),
    getTranslations("ticketEdit.sources"),
  ]);
  const canClose = role.perms.has(TicketPerm.CLOSE);
  const [statusList, cannedList, me, dept] = await Promise.all([
    db()
      .selectFrom("ticket_status")
      .select(["id", "name", "state"])
      .where("state", "in", canClose ? ["open", "closed"] : ["open"])
      // solo stati abilitati, come la select del PHP (isEnabled) e isSelectableStatus lato server
      .where((eb) => eb(eb("mode", "&", TicketStatus.ENABLED), "!=", 0))
      .orderBy("sort")
      .orderBy("name")
      .execute(),
    listCanned(agent),
    db().selectFrom("staff").select(["signature", "default_signature_type"]).where("staff_id", "=", agent.id).executeTakeFirst(),
    db().selectFrom("department").select(["signature", "ispublic"]).where("id", "=", ticket.dept_id).executeTakeFirst(),
  ]);
  const composerLabels: ComposerLabels = {
    reply: tc("reply"),
    note: tc("note"),
    send: tc("send"),
    sending: tc("sending"),
    replyTo: tc("replyTo"),
    replyAll: tc("replyAll"),
    replyUser: tc("replyUser"),
    replyNone: tc("replyNone"),
    collaborators: tc("collaborators"),
    signature: tc("signature"),
    sigNone: tc("sigNone"),
    sigMine: tc("sigMine"),
    sigDept: tc("sigDept"),
    statusAfter: tc("statusAfter"),
    statusUnchanged: tc("statusUnchanged"),
    canned: tc("canned"),
    cannedPick: tc("cannedPick"),
    noteTitle: tc("noteTitle"),
    replyPlaceholder: tc("replyPlaceholder"),
    notePlaceholder: tc("notePlaceholder"),
    posted: tc("posted"),
    lockedBy: tc.raw("lockedBy") as string,
    errors: {
      session_expired: tc("errors.session_expired"),
      not_found: tc("errors.not_found"),
      denied: tc("errors.denied"),
      response_required: tc("errors.response_required"),
      note_required: tc("errors.note_required"),
      lock_required: tc("errors.lock_required"),
      locked_by_other: tc("errors.locked_by_other"),
      lock_expired: tc("errors.lock_expired"),
      banned: tc("errors.banned"),
    },
    editor: {
      bold: tc("editor.bold"),
      italic: tc("editor.italic"),
      underline: tc("editor.underline"),
      bullets: tc("editor.bullets"),
      numbers: tc("editor.numbers"),
      link: tc("editor.link"),
      quote: tc("editor.quote"),
      linkPrompt: tc("editor.linkPrompt"),
    },
  };

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
        <div className="flex flex-wrap items-center gap-2">
          <TicketActionsMenu ticket={ticket} agent={agent} locale={locale} />
          <TicketExtraActions ticket={ticket} agent={agent} locale={locale} />
          <Link
            href={`/agent/tasks?ticket=${ticket.ticket_id}`}
            className="rounded-lg border border-gray-200 px-3 py-2 text-theme-sm text-gray-600 hover:bg-gray-50 dark:border-gray-800 dark:text-gray-400 dark:hover:bg-white/5"
          >
            {t("tasks", { count: taskCount })}
          </Link>
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
          <TicketComposer
            ticketId={ticket.ticket_id}
            canReply={role.perms.has(TicketPerm.REPLY)}
            lockMode={cfg.int("autolock_minutes") > 0 ? cfg.int("ticket_lock", 2) : 0}
            statuses={statusList.map((s) => ({ id: s.id, name: s.name, state: s.state ?? "" }))}
            currentStatusId={ticket.status_id}
            collaborators={collaborators.map((c) => ({ userId: c.user_id, name: c.name, email: c.email ?? "", active: c.active }))}
            canned={cannedList.map((c) => ({ id: c.canned_id, title: c.title }))}
            hasMySignature={!!me?.signature}
            deptSignature={!!(dept?.signature && dept.ispublic)}
            defaultSignature={me?.default_signature_type ?? "none"}
            labels={composerLabels}
            uploadUrl={cfg.bool("allow_attachments") ? "/api/agent/upload" : undefined}
            maxFileSize={cfg.int("max_file_size")}
          />
        </div>

        <aside className="space-y-6">
          <ComponentCard title={t("details")}>
            <dl className="divide-y divide-gray-100 dark:divide-gray-800">
              <Info label={t("department")}>{ticket.dept_name}</Info>
              <Info label={t("helpTopic")}>{ticket.topic_name}</Info>
              <Info label={t("sla")}>{ticket.sla_name}</Info>
              <Info label={t("source")}>{tSource.has(ticket.source) ? tSource(ticket.source) : ticket.source}</Info>
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

          {ticketTasks.length > 0 && (
            <ComponentCard title={t("tasks", { count: ticketTasks.length })}>
              <ul className="divide-y divide-gray-100 dark:divide-gray-800">
                {ticketTasks.map((k) => {
                  const open = (k.flags & TaskModel.ISOPEN) !== 0;
                  return (
                    <li key={k.id} className="flex items-start justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                      <div className="min-w-0">
                        <Link href={`/agent/tasks/${k.id}`} className="block truncate text-theme-sm font-medium text-gray-800 hover:text-brand-600 dark:text-white/90 dark:hover:text-brand-400">
                          #{k.number} · {k.title || tTask("task")}
                        </Link>
                        <p className="truncate text-theme-xs text-gray-500 dark:text-gray-400">
                          {[k.staff_name || k.team_name, k.duedate ? `${tTask("due")} ${formatDbDate(k.duedate, tz, locale, "short")}` : null].filter(Boolean).join(" · ") || k.dept_name}
                        </p>
                      </div>
                      <Badge size="sm" color={open ? "success" : "light"}>
                        {open ? tTask("open") : tTask("completed")}
                      </Badge>
                    </li>
                  );
                })}
              </ul>
            </ComponentCard>
          )}

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
