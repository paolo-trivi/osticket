import { getTranslations, setRequestLocale } from "next-intl/server";

import DataTable, { PageHeader, SearchBox } from "@/components/common/DataTable";
import LinkPager from "@/components/common/LinkPager";
import NewTaskButton from "@/components/people/tasks/NewTaskButton";
import TaskMassActions, { TaskSelect } from "@/components/people/tasks/TaskMassActions";
import Badge from "@/components/ui/badge/Badge";
import { Link } from "@/i18n/navigation";
import { coreConfig } from "@/server/config/config";
import { db } from "@/server/db";
import { pageSizeFor } from "@/server/domain/queue/context";
import { TaskPerm } from "@/server/domain/staff/staff";
import { activeTeams, assignableAgents } from "@/server/domain/task/model";
import { listTasks, TaskFlag, type TaskQueueName } from "@/server/domain/task/tasks";
import { selectableDepts } from "@/server/domain/ticket/assign";
import { checkStaffPerm, loadTicket } from "@/server/domain/ticket/ticket";
import { agentTimeZone, formatDbDate } from "@/server/format/datetime";
import { cn } from "@/utils";

import { requireAgent } from "../../guard";

const QUEUES: TaskQueueName[] = ["open", "assigned", "overdue", "closed"];

export async function generateMetadata() {
  return { title: (await getTranslations("tasks"))("title") };
}

export default async function TasksPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ queue?: string; q?: string; p?: string; ticket?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const agent = await requireAgent(locale);
  const t = await getTranslations("tasks");
  const sp = await searchParams;
  const queue = (QUEUES as string[]).includes(sp.queue ?? "") ? (sp.queue as TaskQueueName) : "open";
  const page = Math.max(1, Number(sp.p) || 1);
  const pageSize = await pageSizeFor(agent);
  // ?ticket=<id>: task di un ticket (ticket-tasks.inc.php), con creazione dal ticket
  const ticket = sp.ticket ? await loadTicket(Number(sp.ticket), agent.id) : null;
  const ticketOk = !!ticket && (await checkStaffPerm(ticket, agent));
  const { rows, total } = await listTasks(agent, { queue, q: sp.q, page, pageSize, ticketId: ticketOk ? ticket!.ticket_id : undefined });
  const tz = await agentTimeZone(agent);
  const tp = await getTranslations("peopleTasks");

  // scp/tasks.php: "Nuovo task" con task.create in almeno un ruolo; azioni di massa secondo i permessi
  const canCreate = ticketOk ? await checkStaffPerm(ticket!, agent, TaskPerm.CREATE) : agent.hasPermInAnyRole(TaskPerm.CREATE);
  const can = {
    claim: agent.hasPermInAnyRole(TaskPerm.ASSIGN),
    assign: agent.hasPermInAnyRole(TaskPerm.ASSIGN),
    transfer: agent.hasPermInAnyRole(TaskPerm.TRANSFER),
    close: agent.hasPermInAnyRole(TaskPerm.CLOSE),
    reopen: agent.hasPermInAnyRole(TaskPerm.CREATE),
    delete: agent.hasPermInAnyRole(TaskPerm.DELETE),
  };
  const cfg = await coreConfig();
  const [agents, teams, depts] = await Promise.all([
    can.assign || canCreate ? assignableAgents(db(), null, agent, cfg) : Promise.resolve([]),
    can.assign || canCreate ? activeTeams(db()) : Promise.resolve([]),
    selectableDepts(db(), agent, null),
  ]);

  return (
    <div className="space-y-5">
      <PageHeader
        title={ticketOk ? tp("ticketTasks", { number: ticket!.number }) : t("title")}
        actions={
          <div className="flex flex-wrap items-center gap-3">
            {canCreate && (
              <NewTaskButton
                ticketId={ticketOk ? ticket!.ticket_id : undefined}
                ticketNumber={ticketOk ? ticket!.number : undefined}
                depts={depts}
                agents={agents}
                teams={teams}
                defaultDept={ticketOk ? ticket!.dept_id : agent.deptId}
                canAssign={agent.hasPermInAnyRole(TaskPerm.ASSIGN)}
              />
            )}
            <SearchBox action="/agent/tasks" value={sp.q} placeholder={t("search")} />
          </div>
        }
      />
      <TaskMassActions can={can} agents={agents} teams={teams} depts={depts} />
      <div className="flex flex-wrap gap-2 border-b border-gray-200 pb-3 dark:border-gray-800">
        {QUEUES.map((q) => (
          <Link
            key={q}
            href={`/agent/tasks?queue=${q}`}
            className={cn(
              "rounded-lg px-3 py-2 text-sm font-medium",
              q === queue && !sp.q ? "bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-400" : "text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/5",
            )}
          >
            {t(`queues.${q}`)}
          </Link>
        ))}
      </div>
      <DataTable
        empty={t("empty")}
        columns={[
          { key: "sel", label: "" },
          { key: "number", label: t("number") },
          { key: "ticket", label: t("ticket") },
          { key: "created", label: t("created") },
          { key: "title", label: t("titleCol") },
          { key: "dept", label: t("department") },
          { key: "assignee", label: t("assignee") },
        ]}
        rows={rows.map((k) => ({
          key: k.id,
          cells: {
            sel: <TaskSelect id={k.id} />,
            number: (
              <Link href={`/agent/tasks/${k.id}`} className="font-medium text-brand-600 hover:underline dark:text-brand-400">
                {k.number}
              </Link>
            ),
            ticket: k.ticket_id ? <Link href={`/agent/tickets/${k.ticket_id}`}>#{k.ticket_number}</Link> : "—",
            created: formatDbDate(k.created, tz, locale, "short"),
            title: (
              <span className="inline-flex items-center gap-2">
                {k.title}
                {(k.flags & TaskFlag.ISOPEN) === 0 && <Badge size="sm" color="light">{t("completed")}</Badge>}
              </span>
            ),
            dept: k.dept_name,
            assignee: k.staff_name ?? k.team_name ?? "—",
          },
        }))}
      />
      <LinkPager
        page={page}
        totalPages={Math.max(1, Math.ceil(total / pageSize))}
        href={(p) => `/agent/tasks?queue=${queue}${sp.q ? `&q=${encodeURIComponent(sp.q)}` : ""}${ticketOk ? `&ticket=${ticket!.ticket_id}` : ""}&p=${p}`}
        labels={{ prev: t("prev"), next: t("next") }}
      />
    </div>
  );
}
