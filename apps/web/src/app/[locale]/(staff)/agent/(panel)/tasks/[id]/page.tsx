import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import ComponentCard from "@/components/common/ComponentCard";
import { PageHeader } from "@/components/common/DataTable";
import InfoRow from "@/components/common/InfoRow";
import TaskActionsBar from "@/components/people/tasks/TaskActionsBar";
import TaskComposer from "@/components/people/tasks/TaskComposer";
import ThreadEntryCard from "@/components/tickets/ThreadEntryCard";
import Badge from "@/components/ui/badge/Badge";
import { Link } from "@/i18n/navigation";
import { Dept, TaskModel } from "@/lib/osticket/flags";
import { coreConfig } from "@/server/config/config";
import { db } from "@/server/db";
import { editFormFields } from "@/server/domain/directory/ui";
import { TaskPerm } from "@/server/domain/staff/staff";
import { activeTeams, assignableAgents } from "@/server/domain/task/model";
import { checkTaskPerm, loadTask } from "@/server/domain/task/tasks";
import { missingRequiredFields } from "@/server/domain/task/write";
import { selectableDepts } from "@/server/domain/ticket/assignees";
import { loadThreadEntries } from "@/server/domain/ticket/ticket";
import { agentTimeZone, formatDbDate, isoOf } from "@/server/format/datetime";

import { requireAgent } from "../../../guard";

export default async function TaskPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const agent = await requireAgent(locale);
  const task = await loadTask(Number(id));
  if (!task || !checkTaskPerm(task, agent)) notFound();
  const t = await getTranslations("tasks");
  const tt = await getTranslations("ticket");
  const tz = await agentTimeZone(agent);
  const entries = task.thread_id ? await loadThreadEntries(task.thread_id) : [];
  const open = (task.flags & TaskModel.ISOPEN) !== 0;

  // task-view.tmpl.php: azioni secondo il ruolo dell'agente nel reparto del task
  const role = agent.roleFor(task.dept_id);
  const has = (p: string) => role.perms.has(p);
  const cfg = await coreConfig();
  const dept = await db().selectFrom("department").select(["flags"]).where("id", "=", task.dept_id).executeTakeFirst();
  const membersOnly = !!dept && (dept.flags & Dept.ASSIGN_MEMBERS_ONLY) !== 0;
  const isMember = agent.deptId === task.dept_id || agent.deptIds.includes(task.dept_id);
  const [agents, teams, depts, fields, missing] = await Promise.all([
    has(TaskPerm.ASSIGN) && open ? assignableAgents(db(), task.dept_id, agent, cfg) : Promise.resolve([]),
    has(TaskPerm.ASSIGN) && open ? activeTeams(db()) : Promise.resolve([]),
    has(TaskPerm.TRANSFER) ? selectableDepts(db(), agent, task.dept_id) : Promise.resolve([]),
    has(TaskPerm.EDIT) ? editFormFields("A", task.id, {}) : Promise.resolve([]),
    open ? missingRequiredFields(db(), task.id) : Promise.resolve(0),
  ]);

  return (
    <div className="space-y-6">
      <Link href="/agent/tasks" className="text-theme-sm text-gray-500 hover:text-brand-500">
        ← {t("title")}
      </Link>
      <PageHeader title={`${t("task")} #${task.number} · ${task.title ?? ""}`} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Badge color={open ? "success" : "light"}>{open ? t("open") : t("completed")}</Badge>
        <TaskActionsBar
          data={{
            taskId: task.id,
            number: task.number,
            isOpen: open,
            assignedToMe: task.staff_id === agent.id,
            assignee: task.staff_name ?? task.team_name,
            deptId: task.dept_id,
            dueIso: isoOf(task.duedate) ?? null,
            can: {
              claim: has(TaskPerm.ASSIGN) && (!membersOnly || isMember),
              assign: has(TaskPerm.ASSIGN),
              transfer: has(TaskPerm.TRANSFER),
              edit: has(TaskPerm.EDIT),
              delete: has(TaskPerm.DELETE),
              close: has(TaskPerm.CLOSE),
              reopen: has(TaskPerm.CREATE),
            },
            closeBlocked: missing > 0,
            agents,
            teams,
            depts,
            fields,
          }}
        />
      </div>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          {entries.map((e) => (
            <ThreadEntryCard
              key={e.id}
              entry={e}
              tz={tz}
              locale={locale}
              iframeWhitelist={[]}
              labels={{ note: tt("internalNote"), reply: tt("reply"), message: tt("message"), edited: tt("editedBy"), via: tt("via") }}
            />
          ))}
          <TaskComposer taskId={task.id} isOpen={open} canReply={has(TaskPerm.REPLY)} canClose={has(TaskPerm.CLOSE) && missing === 0} canReopen={has(TaskPerm.CREATE)} />
        </div>
        <ComponentCard title={tt("details")}>
          <dl>
            <InfoRow label={t("ticket")} value={task.ticket_id ? <Link href={`/agent/tickets/${task.ticket_id}`}>#{task.ticket_number}</Link> : "—"} />
            <InfoRow label={t("department")} value={task.dept_name} />
            <InfoRow label={t("assignee")} value={task.staff_name ?? task.team_name} />
            <InfoRow label={t("created")} value={formatDbDate(task.created, tz, locale)} />
            <InfoRow label={t("due")} value={formatDbDate(task.duedate, tz, locale)} />
            {task.closed && <InfoRow label={t("closedOn")} value={formatDbDate(task.closed, tz, locale)} />}
          </dl>
        </ComponentCard>
      </div>
    </div>
  );
}
