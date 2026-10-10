import { ArrowDown, ArrowUp } from "lucide-react";
import { getTranslations, setRequestLocale } from "next-intl/server";

import Alert from "@/components/ui/alert/Alert";
import { Link, redirect } from "@/i18n/navigation";
import { withBase } from "@/lib/base-path";
import { coreConfig } from "@/server/config/config";
import { clientTicketStats, listClientTickets, type ClientSort } from "@/server/domain/client/tickets";
import { formatDbDate } from "@/server/format/datetime";
import { cn } from "@/utils";

import { requireClient } from "../guard";

export async function generateMetadata() {
  const t = await getTranslations("portal.tickets");
  return { title: t("title") };
}

const SORTS: ClientSort[] = ["id", "date", "status", "subject", "dept"];

/**
 * tickets.php (include/client/tickets.inc.php): ticket propri, da collaboratore e dell'organizzazione
 * se condivisa; filtro aperti/chiusi, help topic, ricerca e ordinamento. Senza ticket si passa
 * all'apertura di un nuovo ticket, come il PHP.
 */
export default async function ClientTicketsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{
    status?: string;
    topic?: string;
    q?: string;
    sort?: string;
    order?: string;
    p?: string;
    profile?: string;
  }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const sp = await searchParams;
  const client = await requireClient(locale, "/tickets");
  if (client.guest) redirect({ href: `/tickets/${client.guest.ticketId}`, locale });
  const t = await getTranslations("portal.tickets");
  const ta = await getTranslations("portal.account");
  const cfg = await coreConfig();
  const stats = await clientTicketStats(cfg, client);
  // senza ticket si va all'apertura, portando con sé l'esito del salvataggio del profilo
  if (!stats.open && !stats.closed) redirect({ href: sp.profile ? "/open?profile=1" : "/open", locale });
  const status = sp.status === "closed" ? "closed" : "open";
  const sort = SORTS.includes(sp.sort as ClientSort) ? (sp.sort as ClientSort) : "date";
  const order = sp.order === "ASC" ? "ASC" : "DESC";
  const topicId = Number(sp.topic) || undefined;
  const page = Math.max(1, Number(sp.p) || 1);
  const list = await listClientTickets(cfg, client, { status, topicId, keywords: sp.q, sort, order, page });
  const tz = client.account?.timezone || cfg.str("default_timezone") || "UTC";
  const pages = Math.max(1, Math.ceil(list.total / list.pageSize));
  const qs = (over: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    const base: Record<string, string | number | undefined> = { status, topic: topicId, q: sp.q, sort, order, ...over };
    for (const [k, v] of Object.entries(base)) if (v !== undefined && v !== "") p.set(k, String(v));
    return `/tickets?${p.toString()}`;
  };

  return (
    <div className="space-y-6">
      {/* esito del salvataggio del profilo (profileAction → ?profile=1) */}
      {sp.profile && (
        <div>
          <Alert variant="success" title={ta("profileSaved")} message="" />
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-title-sm font-semibold text-gray-800 dark:text-white/90">{t("title")}</h1>
        <div className="flex gap-2">
          {(["open", "closed"] as const).map((s) => (
            <Link
              key={s}
              href={qs({ status: s, p: undefined })}
              className={cn(
                "rounded-lg px-4 py-2 text-theme-sm font-medium",
                status === s ? "bg-brand-500 text-white" : "border border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-white/5",
              )}
            >
              {t(s)} ({s === "open" ? stats.open : stats.closed})
            </Link>
          ))}
        </div>
      </div>

      <form action={withBase("/tickets")} method="get" className="flex flex-col gap-3 sm:flex-row" role="search">
        <input type="hidden" name="status" value={status} />
        <input
          name="q"
          defaultValue={sp.q ?? ""}
          placeholder={t("search")}
          aria-label={t("search")}
          className="h-11 flex-1 rounded-lg border border-gray-300 bg-white px-4 text-sm shadow-theme-xs dark:border-gray-700 dark:bg-gray-900 dark:text-white/90"
        />
        <select name="topic" defaultValue={topicId ?? ""} aria-label={t("topic")} className="h-11 rounded-lg border border-gray-300 bg-white px-4 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-white/90">
          <option value="">{t("allTopics")}</option>
          {stats.topics.map((tp) => (
            <option key={tp.id} value={tp.id}>
              {tp.name} ({tp.count})
            </option>
          ))}
        </select>
        <button type="submit" className="h-11 rounded-lg bg-brand-500 px-6 text-sm font-medium text-white shadow-theme-xs hover:bg-brand-600">
          {t("go")}
        </button>
        {(sp.q || topicId || sp.sort) && (
          <Link href="/tickets" className="h-11 px-2 text-theme-sm leading-11 text-gray-500 hover:underline dark:text-gray-400">
            {t("clear")}
          </Link>
        )}
      </form>

      <div className="overflow-x-auto rounded-2xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-white/3">
        <table className="min-w-full text-start text-theme-sm">
          <thead className="border-b border-gray-200 text-theme-xs text-gray-500 uppercase dark:border-gray-800 dark:text-gray-400">
            <tr>
              {(["id", "date", "status", "subject", "dept"] as ClientSort[]).map((c) => (
                <th key={c} className="px-5 py-3 text-start font-medium">
                  <Link
                    href={qs({
                      sort: c,
                      order: sort === c && order === "DESC" ? "ASC" : "DESC",
                      p: undefined,
                    })}
                    className="inline-flex items-center gap-1 hover:text-gray-700 dark:hover:text-gray-200"
                  >
                    {t(`col.${c}`)}
                    {sort === c ? order === "DESC" ? <ArrowDown className="size-3.5" /> : <ArrowUp className="size-3.5" /> : null}
                  </Link>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {list.items.length === 0 && (
              <tr>
                <td colSpan={5} className="px-5 py-6 text-center text-gray-500 dark:text-gray-400">
                  {t("empty")}
                </td>
              </tr>
            )}
            {list.items.map((r) => (
              <tr key={r.id} className="hover:bg-gray-50 dark:hover:bg-white/5">
                <td className="px-5 py-3 whitespace-nowrap">
                  <Link href={`/tickets/${r.id}`} className={cn("font-medium text-brand-600 hover:underline dark:text-brand-400", !r.isanswered && "font-semibold")}>
                    #{r.number}
                  </Link>
                </td>
                <td className="px-5 py-3 whitespace-nowrap text-gray-600 dark:text-gray-400">{formatDbDate(r.created, tz, locale, "short")}</td>
                <td className="px-5 py-3 text-gray-600 dark:text-gray-400">{r.statusName}</td>
                <td className="px-5 py-3 text-gray-800 dark:text-white/90">
                  <Link href={`/tickets/${r.id}`} className="hover:underline">
                    {r.subject}
                  </Link>
                </td>
                <td className="px-5 py-3 text-gray-600 dark:text-gray-400">{r.dept}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <nav className="flex justify-center gap-2" aria-label={t("pages")}>
          {Array.from({ length: pages }, (_, i) => i + 1).map((n) => (
            <Link
              key={n}
              href={qs({ p: n })}
              className={cn("rounded-lg px-3 py-1.5 text-theme-sm", n === page ? "bg-brand-500 text-white" : "text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-white/5")}
            >
              {n}
            </Link>
          ))}
        </nav>
      )}
    </div>
  );
}
