import { getTranslations } from "next-intl/server";

import ComponentCard from "@/components/common/ComponentCard";
import Badge from "@/components/ui/badge/Badge";
import { Link } from "@/i18n/navigation";
import { TaskModel } from "@/lib/osticket/flags";
import type { TaskRow } from "@/server/domain/task/tasks";
import { formatDbDate } from "@/server/format/datetime";

interface TicketTasksCardProps {
  tasks: TaskRow[];
  tz: string;
  locale: string;
}

/** Scheda "Task" della vista ticket (ticket-view.inc.php): task collegati, con assegnatario, scadenza e stato. */
export default async function TicketTasksCard({ tasks, tz, locale }: TicketTasksCardProps) {
  const t = await getTranslations("ticket");
  const tTask = await getTranslations("tasks");
  return (
    <ComponentCard title={t("tasks", { count: tasks.length })}>
      <ul className="divide-y divide-gray-100 dark:divide-gray-800">
        {tasks.map((k) => {
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
  );
}
