import { getTranslations, setRequestLocale } from "next-intl/server";

import DataTable, { PageHeader, SearchBox } from "@/components/common/DataTable";
import LinkPager from "@/components/common/LinkPager";
import PeopleCards from "@/components/people/PeopleCards";
import PeopleDoneNotice from "@/components/people/PeopleDoneNotice";
import NewTaskButton from "@/components/people/tasks/NewTaskButton";
import TaskMassActions, { TaskSelect } from "@/components/people/tasks/TaskMassActions";
import Badge from "@/components/ui/badge/Badge";
import { Link } from "@/i18n/navigation";
import { TaskModel } from "@/lib/osticket/flags";
import { coreConfig } from "@/server/config/config";
import { db } from "@/server/db";
import { newFormFields } from "@/server/domain/directory/ui";
import { pageSizeFor } from "@/server/domain/queue/context";
import { TaskPerm } from "@/server/domain/staff/staff";
import { activeTeams, assignableAgents } from "@/server/domain/task/model";
import { countTaskQueues, listTasks, type TaskQueueName, type TaskRow } from "@/server/domain/task/tasks";
import { selectableDepts } from "@/server/domain/ticket/assignees";
import { checkStaffPerm, loadTicket } from "@/server/domain/ticket/ticket";
import { agentTimeZone, formatDbDate } from "@/server/format/datetime";
import { cn } from "@/utils";

import { requireAgent } from "../../guard";

const QUEUES: TaskQueueName[] = ["open", "assigned", "overdue", "closed"];

export async function generateMetadata() {
  return { title: (await getTranslations("tasks"))("title") };
}

/** Numero del ticket del task come link (stile dei link delle liste). */
function ticketLink(k: TaskRow) {
  return k.ticket_id ? (
    <Link href={`/agent/tickets/${k.ticket_id}`} className="text-brand-600 hover:underline dark:text-brand-400">
      #{k.ticket_number}
    </Link>
  ) : (
    "—"
  );
}

export default async function TasksPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{
    queue?: string;
    q?: string;
    p?: string;
    ticket?: string;
    done?: string;
    n?: string;
  }>;
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
  const ticketId = ticketOk ? ticket!.ticket_id : undefined;
  // Con ?ticket= senza scheda scelta tutti i task del ticket (ticket-tasks.inc.php); le schede e i loro
  // contatori restano limitati al ticket
  const queueChosen = !ticketId || (QUEUES as string[]).includes(sp.queue ?? "");
  const [{ rows, total }, counts] = await Promise.all([
    listTasks(agent, {
      queue,
      q: sp.q,
      page,
      pageSize,
      ticketId,
      ticketQueue: queueChosen,
    }),
    countTaskQueues(agent, QUEUES, { ticketId }),
  ]);
  const ticketParam = ticketId ? `&ticket=${ticketId}` : "";
  const pageQuery = (p: number) => {
    const qs = new URLSearchParams();
    if (queueChosen) qs.set("queue", queue);
    if (sp.q) qs.set("q", sp.q);
    if (ticketId) qs.set("ticket", String(ticketId));
    qs.set("p", String(p));
    return qs.toString();
  };
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
  const [agents, teams, depts, taskFields] = await Promise.all([
    can.assign || canCreate ? assignableAgents(db(), null, agent, cfg) : Promise.resolve([]),
    can.assign || canCreate ? activeTeams(db()) : Promise.resolve([]),
    selectableDepts(db(), agent, null),
    canCreate ? newFormFields("A") : Promise.resolve([]),
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
                fields={taskFields}
                defaultDept={ticketOk ? ticket!.dept_id : agent.deptId}
                canAssign={agent.hasPermInAnyRole(TaskPerm.ASSIGN)}
              />
            )}
            <SearchBox action="/agent/tasks" value={sp.q} placeholder={t("search")} />
          </div>
        }
      />
      <PeopleDoneNotice done={sp.done} n={sp.n} />
      <TaskMassActions can={can} agents={agents} teams={teams} depts={depts} />
      <div className="flex flex-wrap gap-2 border-b border-gray-200 pb-3 dark:border-gray-800">
        {QUEUES.map((q) => (
          <Link
            key={q}
            href={`/agent/tasks?queue=${q}${ticketParam}`}
            className={cn(
              "rounded-lg px-3 py-2 text-sm font-medium",
              q === queue && !sp.q && queueChosen
                ? "bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-400"
                : "text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/5",
            )}
          >
            {t(`queues.${q}`)}
            <span className="ms-1.5 rounded-full bg-gray-100 px-1.5 text-theme-xs text-gray-600 tabular-nums dark:bg-white/5 dark:text-gray-400">{counts[q]}</span>
          </Link>
        ))}
      </div>
      <PeopleCards
        empty={t("empty")}
        cards={rows.map((k) => ({
          key: k.id,
          select: <TaskSelect id={k.id} />,
          title: (
            <Link href={`/agent/tasks/${k.id}`} className="text-brand-600 hover:underline dark:text-brand-400">
              #{k.number} · {k.title}
            </Link>
          ),
          badge:
            (k.flags & TaskModel.ISOPEN) === 0 ? (
              <Badge size="sm" color="light">
                {t("completed")}
              </Badge>
            ) : undefined,
          meta: [
            { label: t("ticket"), value: ticketLink(k) },
            { label: t("created"), value: formatDbDate(k.created, tz, locale) },
            { label: t("department"), value: k.dept_name },
            { label: t("assignee"), value: k.staff_name ?? k.team_name ?? "—" },
          ],
        }))}
      />
      <div className="hidden md:block">
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
              ticket: ticketLink(k),
              created: formatDbDate(k.created, tz, locale),
              title: (
                <span className="inline-flex items-center gap-2">
                  {k.title}
                  {(k.flags & TaskModel.ISOPEN) === 0 && (
                    <Badge size="sm" color="light">
                      {t("completed")}
                    </Badge>
                  )}
                </span>
              ),
              dept: k.dept_name,
              assignee: k.staff_name ?? k.team_name ?? "—",
            },
          }))}
        />
      </div>
      <LinkPager page={page} totalPages={Math.max(1, Math.ceil(total / pageSize))} href={(p) => `/agent/tasks?${pageQuery(p)}`} labels={{ prev: t("prev"), next: t("next") }} />
    </div>
  );
}
