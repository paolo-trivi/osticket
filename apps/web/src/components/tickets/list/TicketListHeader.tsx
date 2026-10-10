import { getTranslations } from "next-intl/server";

import type { queueSorts } from "@/server/domain/queue/columns";
import type { TicketQueue } from "@/server/domain/queue/queues";

interface TicketListHeaderProps {
  queue: TicketQueue;
  /** ricerca rapida corrente ("" se si naviga una coda) */
  query: string;
  /** totale della lista (null se non noto) */
  totalNum: number | null;
  sorts: Awaited<ReturnType<typeof queueSorts>>;
  /** ordinamento richiesto (?sort) */
  sort?: string;
}

/** Titolo della lista (coda o ricerca, con il totale) e scelta dell'ordinamento della coda. */
export default async function TicketListHeader({ queue, query, totalNum, sorts, sort }: TicketListHeaderProps) {
  const t = await getTranslations("tickets");
  const tq = await getTranslations("queues");
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-xl font-semibold text-gray-800 dark:text-white/90">
        {query ? t("searchResults", { query }) : queue.id ? (tq.has(queue.title) ? tq(queue.title) : queue.title) : queue.title}
        {totalNum !== null && <span className="ms-2 text-base font-normal text-gray-500">({totalNum})</span>}
      </h2>
      {sorts.length > 0 && (
        <form action="/agent/tickets" className="flex w-full flex-wrap items-center gap-2 text-sm sm:w-auto">
          {query ? <input type="hidden" name="q" value={query} /> : <input type="hidden" name="queue" value={queue.id} />}
          <label htmlFor="sort" className="text-gray-500">
            {t("sortBy")}
          </label>
          <select
            id="sort"
            name="sort"
            defaultValue={sort?.startsWith("qs-") ? sort : `qs-${queue.defaultSortId() ?? ""}`}
            className="h-9 min-w-0 flex-1 rounded-lg border border-gray-200 bg-transparent px-2 text-sm sm:flex-none dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300"
          >
            {sorts.map((s) => (
              <option key={s.id} value={`qs-${s.id}`}>
                {tq.has(s.name) ? tq(s.name) : s.name}
              </option>
            ))}
          </select>
          <button type="submit" className="h-9 rounded-lg bg-brand-500 px-3 text-white hover:bg-brand-600">
            {t("apply")}
          </button>
        </form>
      )}
    </div>
  );
}
