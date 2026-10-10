import { getTranslations, setRequestLocale } from "next-intl/server";

import LinkPager from "@/components/common/LinkPager";
import QueueTabs from "@/components/tickets/list/QueueTabs";
import TicketListCards from "@/components/tickets/list/TicketListCards";
import TicketListHeader from "@/components/tickets/list/TicketListHeader";
import TicketListTable from "@/components/tickets/list/TicketListTable";
import TicketMassBar from "@/components/tickets/mass/TicketMassBar";
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

  // Totale della lista stessa (stesse condizioni), non il contatore della coda: vedi listQueueTickets
  const total = result.total;
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
      <QueueTabs top={top} subQueues={subQueues} activeTopId={activeTop?.id ?? null} currentQueueId={queue.id} counts={counts} />

      <TicketListHeader queue={queue} query={query} totalNum={totalNum} sorts={sorts} sort={sp.sort} />

      {searchError && <p className="text-sm text-error-500">{t("tooManyWords")}</p>}

      {/* Area "ticketedit": azioni di massa sui ticket selezionati ed export CSV della coda */}
      <TicketMassBar agent={agent} queue={queue.id ? queue : null} sort={sp.sort} dir={sp.dir} />

      <TicketListCards rows={rows} columns={columns} names={names} tz={tz} locale={locale} />
      <TicketListTable
        rows={rows}
        columns={columns}
        names={names}
        tz={tz}
        locale={locale}
        sort={sp.sort}
        dir={dir}
        sortHref={(sort, nextDir) => baseParams({ sort, dir: nextDir, p: undefined })}
      />

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
