import { getTranslations, setRequestLocale } from "next-intl/server";

import LinkPager from "@/components/common/LinkPager";
import MassSelectAll from "@/components/tickets/mass/MassSelectAll";
import TicketMassBar from "@/components/tickets/mass/TicketMassBar";
import TicketCell from "@/components/tickets/TicketCell";
import { Link } from "@/i18n/navigation";
import { agentQueueNav, defaultQueueId, pageSizeFor } from "@/server/domain/queue/context";
import {
  adhocQueue,
  listQueueTickets,
  queueColumns,
  queueSorts,
  quickSearchCriteria,
  type TicketQueue,
} from "@/server/domain/queue/engine";
import { formatAgentName, loadTicketRows } from "@/server/domain/ticket/rows";
import { agentTimeZone } from "@/server/format/datetime";
import { cn } from "@/utils";

import { requireAgent } from "../../guard";

type Search = { queue?: string; sort?: string; dir?: string; p?: string; q?: string; user?: string; org?: string };

export async function generateMetadata() {
  const t = await getTranslations("tickets");
  return { title: t("title") };
}

export default async function TicketsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Search>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const agent = await requireAgent(locale);
  const sp = await searchParams;
  const t = await getTranslations("tickets");
  const tq = await getTranslations("queues");
  const queueName = (q: TicketQueue) => (tq.has(q.title) ? tq(q.title) : q.title);

  const { all, top, counts } = await agentQueueNav(agent);
  const tz = await agentTimeZone(agent);

  // Coda corrente: ricerca rapida, ?queue, preferenza agente, default di sistema
  const query = sp.q?.trim() ?? "";
  let queue: TicketQueue | undefined;
  let searchError = false;
  if (query) {
    const criteria = quickSearchCriteria(query);
    if (criteria) queue = adhocQueue(agent, criteria, query);
    else searchError = true;
  }
  // Ticket di un utente o di un'organizzazione (scp/tickets.php?uid= / ?orgid=)
  if (!queue && sp.user) queue = adhocQueue(agent, [["user_id", "equal", Number(sp.user)]], t("userTickets"));
  if (!queue && sp.org) queue = adhocQueue(agent, [["user__org_id", "equal", Number(sp.org)]], t("orgTickets"));
  if (!queue) queue = all.get(Number(sp.queue) || (await defaultQueueId(agent))) ?? all.get(1);
  if (!queue) return null;

  const dir = sp.dir === "1" ? 1 : 0;
  const page = Math.max(1, Number(sp.p) || 1);
  const pageSize = await pageSizeFor(agent);
  const [columns, sorts, result] = await Promise.all([
    queueColumns(queue),
    queueSorts(queue),
    listQueueTickets(agent, queue, { sort: sp.sort, dir, page, pageSize }, { userTz: tz }),
  ]);
  const rows = await loadTicketRows(result.ids, agent.id);
  const names = new Map<number, string>();
  for (const r of rows) {
    if (r.staff_id && !names.has(r.staff_id)) names.set(r.staff_id, await formatAgentName(r.staff_first, r.staff_last));
  }

  const total = query ? null : queue.id ? (counts.get(queue.id) ?? result.total) : result.total;
  const totalNum = typeof total === "number" ? total : null;
  const totalPages = totalNum !== null ? Math.max(1, Math.ceil(totalNum / pageSize)) : rows.length < pageSize ? page : null;

  const baseParams = (extra: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    if (query) p.set("q", query);
    else if (sp.user) p.set("user", sp.user);
    else if (sp.org) p.set("org", sp.org);
    else p.set("queue", String(queue!.id));
    for (const [k, v] of Object.entries({ sort: sp.sort, dir: sp.dir, ...extra })) {
      if (v !== undefined && v !== "") p.set(k, String(v));
    }
    return `/agent/tickets?${p.toString()}`;
  };

  const activeTop = queue.id ? (queue.parent && !queue.parent.parent ? queue.parent : queue) : null;
  const subQueues = activeTop ? activeTop.children.filter((c) => counts.has(c.id)) : [];

  return (
    <div className="space-y-5">
      {/* Code di primo livello */}
      <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 pb-3 dark:border-gray-800">
        {top.map((q) => {
          const active = activeTop?.id === q.id;
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
                q.id === queue.id
                  ? "border-brand-300 bg-brand-50 text-brand-600 dark:border-brand-700 dark:bg-brand-500/15 dark:text-brand-400"
                  : "border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-gray-800 dark:text-gray-400 dark:hover:bg-white/5",
              )}
            >
              {queueName(q)} <span className="text-gray-400">{typeof counts.get(q.id) === "number" ? counts.get(q.id) : ""}</span>
            </Link>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold text-gray-800 dark:text-white/90">
          {query ? t("searchResults", { query }) : queue.id ? queueName(queue) : queue.title}
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
              defaultValue={sp.sort?.startsWith("qs-") ? sp.sort : `qs-${queue.defaultSortId() ?? ""}`}
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

      {searchError && <p className="text-sm text-error-500">{t("tooManyWords")}</p>}

      {/* Area "ticketedit": azioni di massa sui ticket selezionati ed export CSV della coda */}
      <TicketMassBar agent={agent} queue={queue.id ? queue : null} sort={sp.sort} dir={sp.dir} />

      {/* Mobile: una scheda per ticket con tutte le colonne della coda */}
      <ul className="space-y-3 md:hidden">
        {rows.length === 0 && (
          <li className="rounded-2xl border border-gray-200 bg-white px-4 py-8 text-center text-sm text-gray-500 dark:border-gray-800 dark:bg-white/3 dark:text-gray-400">
            {t("empty")}
          </li>
        )}
        {rows.map((r) => {
          const staff = names.get(r.staff_id) ?? "";
          const assignee = staff || r.team_name || "";
          return (
            <li key={r.ticket_id} className="flex gap-3 rounded-2xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-white/3">
              <input type="checkbox" data-mass-tid value={r.ticket_id} aria-label={`#${r.number}`} className="mt-1 size-4 shrink-0 accent-brand-500" />
              <dl className="grid min-w-0 flex-1 grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
                {columns.map((c) => (
                  <div key={c.id} className="contents">
                    <dt className="text-theme-xs text-gray-500 uppercase dark:text-gray-400">{tq.has(c.heading) ? tq(c.heading) : c.heading}</dt>
                    <dd className="min-w-0 break-words text-gray-700 dark:text-gray-300">
                      <TicketCell column={c} row={r} tz={tz} locale={locale} assigneeName={assignee} staffName={staff} />
                    </dd>
                  </div>
                ))}
              </dl>
            </li>
          );
        })}
      </ul>

      <div className="hidden overflow-x-auto rounded-2xl border border-gray-200 bg-white md:block dark:border-gray-800 dark:bg-white/3">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 dark:border-gray-800">
              <th className="w-10 px-4 py-3">
                <MassSelectAll />
              </th>
              {columns.map((c) => {
                const sorted = sp.sort === String(c.id);
                const nextDir = sorted && dir === 0 ? 1 : 0;
                return (
                  <th
                    key={c.id}
                    style={{ width: c.width }}
                    className="px-4 py-3 text-start text-theme-xs font-medium whitespace-nowrap text-gray-500 uppercase dark:text-gray-400"
                  >
                    {c.sortable ? (
                      <Link href={baseParams({ sort: c.id, dir: nextDir, p: undefined })} className="hover:text-gray-800 dark:hover:text-white">
                        {tq.has(c.heading) ? tq(c.heading) : c.heading}
                        {sorted ? (dir === 1 ? " ▲" : " ▼") : ""}
                      </Link>
                    ) : tq.has(c.heading) ? (
                      tq(c.heading)
                    ) : (
                      c.heading
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {rows.length === 0 && (
              <tr>
                <td colSpan={columns.length + 1} className="px-4 py-10 text-center text-gray-500 dark:text-gray-400">
                  {t("empty")}
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const staff = names.get(r.staff_id) ?? "";
              const assignee = staff || r.team_name || "";
              return (
                <tr key={r.ticket_id} className="hover:bg-gray-50 dark:hover:bg-white/2">
                  <td className="px-4 py-3">
                    <input type="checkbox" data-mass-tid value={r.ticket_id} aria-label={`#${r.number}`} className="size-4 accent-brand-500" />
                  </td>
                  {columns.map((c) => (
                    <td key={c.id} className="max-w-xs px-4 py-3 text-gray-700 dark:text-gray-300">
                      <TicketCell column={c} row={r} tz={tz} locale={locale} assigneeName={assignee} staffName={staff} />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-theme-sm text-gray-500 dark:text-gray-400">
          {t("pageOf", { page, pages: totalPages ?? "?" })}
        </p>
        <LinkPager
          page={page}
          totalPages={totalPages}
          href={(p) => baseParams({ p })}
          labels={{ prev: t("prev"), next: t("next") }}
        />
      </div>
    </div>
  );
}
