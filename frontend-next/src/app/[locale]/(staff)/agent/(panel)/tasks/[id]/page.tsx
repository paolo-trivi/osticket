import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import ComponentCard from "@/components/common/ComponentCard";
import { PageHeader } from "@/components/common/DataTable";
import InfoRow from "@/components/common/InfoRow";
import ThreadEntryCard from "@/components/tickets/ThreadEntryCard";
import Badge from "@/components/ui/badge/Badge";
import { Link } from "@/i18n/navigation";
import { checkTaskPerm, loadTask, TaskFlag } from "@/server/domain/task/tasks";
import { loadThreadEntries } from "@/server/domain/ticket/ticket";
import { agentTimeZone, formatDbDate } from "@/server/format/datetime";

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
  const open = (task.flags & TaskFlag.ISOPEN) !== 0;
  return (
    <div className="space-y-6">
      <Link href="/agent/tasks" className="text-theme-sm text-gray-500 hover:text-brand-500">
        ← {t("title")}
      </Link>
      <PageHeader title={`${t("task")} #${task.number} · ${task.title ?? ""}`} />
      <Badge color={open ? "success" : "light"}>{open ? t("open") : t("completed")}</Badge>
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
