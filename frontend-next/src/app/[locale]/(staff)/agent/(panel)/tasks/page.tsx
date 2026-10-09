import { getTranslations, setRequestLocale } from "next-intl/server";

import DataTable, { PageHeader, SearchBox } from "@/components/common/DataTable";
import LinkPager from "@/components/common/LinkPager";
import Badge from "@/components/ui/badge/Badge";
import { Link } from "@/i18n/navigation";
import { pageSizeFor } from "@/server/domain/queue/context";
import { listTasks, TaskFlag, type TaskQueueName } from "@/server/domain/task/tasks";
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
  searchParams: Promise<{ queue?: string; q?: string; p?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const agent = await requireAgent(locale);
  const t = await getTranslations("tasks");
  const sp = await searchParams;
  const queue = (QUEUES as string[]).includes(sp.queue ?? "") ? (sp.queue as TaskQueueName) : "open";
  const page = Math.max(1, Number(sp.p) || 1);
  const pageSize = await pageSizeFor(agent);
  const { rows, total } = await listTasks(agent, { queue, q: sp.q, page, pageSize });
  const tz = await agentTimeZone(agent);

  return (
    <div className="space-y-5">
      <PageHeader title={t("title")} actions={<SearchBox action="/agent/tasks" value={sp.q} placeholder={t("search")} />} />
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
        href={(p) => `/agent/tasks?queue=${queue}${sp.q ? `&q=${encodeURIComponent(sp.q)}` : ""}&p=${p}`}
        labels={{ prev: t("prev"), next: t("next") }}
      />
    </div>
  );
}
