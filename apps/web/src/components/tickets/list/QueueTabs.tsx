import { getTranslations } from "next-intl/server";

import { Link } from "@/i18n/navigation";
import type { agentQueueNav } from "@/server/domain/queue/context";
import type { TicketQueue } from "@/server/domain/queue/queues";
import { cn } from "@/utils";

interface QueueTabsProps {
  /** code di primo livello */
  top: TicketQueue[];
  /** sotto-code della coda di primo livello attiva */
  subQueues: TicketQueue[];
  activeTopId: number | null;
  currentQueueId: number;
  /** contatori delle code (assenti se non calcolati) */
  counts: Awaited<ReturnType<typeof agentQueueNav>>["counts"];
}

/** Navigazione tra le code della lista ticket: schede di primo livello e, sotto, le sotto-code. */
export default async function QueueTabs({ top, subQueues, activeTopId, currentQueueId, counts }: QueueTabsProps) {
  const tq = await getTranslations("queues");
  const queueName = (q: TicketQueue) => (tq.has(q.title) ? tq(q.title) : q.title);
  return (
    <>
      {/* Code di primo livello */}
      <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 pb-3 dark:border-gray-800">
        {top.map((q) => {
          const active = activeTopId === q.id;
          const c = counts.get(q.id);
          return (
            <Link
              key={q.id}
              href={`/agent/tickets?queue=${q.id}`}
              className={cn(
                "inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium",
                active
                  ? "bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-400"
                  : "text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/5",
              )}
            >
              {queueName(q)}
              {typeof c === "number" && (
                <span className="rounded-full bg-white px-2 text-theme-xs text-gray-600 shadow-theme-xs dark:bg-gray-800 dark:text-gray-300">
                  {c}
                </span>
              )}
            </Link>
          );
        })}
      </div>

      {subQueues.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {subQueues.map((q) => (
            <Link
              key={q.id}
              href={`/agent/tickets?queue=${q.id}`}
              className={cn(
                "rounded-full border px-3 py-1 text-theme-sm",
                q.id === currentQueueId
                  ? "border-brand-300 bg-brand-50 text-brand-600 dark:border-brand-700 dark:bg-brand-500/15 dark:text-brand-400"
                  : "border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-gray-800 dark:text-gray-400 dark:hover:bg-white/5",
              )}
            >
              {queueName(q)} <span className="text-gray-400">{typeof counts.get(q.id) === "number" ? counts.get(q.id) : ""}</span>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
