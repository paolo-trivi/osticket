import { getTranslations, setRequestLocale } from "next-intl/server";

import ComponentCard from "@/components/common/ComponentCard";
import DataTable from "@/components/common/DataTable";
import EventsChart from "@/components/dashboard/EventsChart";
import { Link } from "@/i18n/navigation";
import { agentQueueNav } from "@/server/domain/queue/context";
import { PERIOD_CHOICES, plotData, reportRange, tabularData, type PeriodEnd } from "@/server/domain/stats/report";
import { agentTimeZone } from "@/server/format/datetime";
import { cn } from "@/utils";

import { requireAgent } from "../guard";

export async function generateMetadata() {
  return { title: (await getTranslations("dashboard"))("title") };
}

export default async function AgentDashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ start?: string; period?: string; group?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const agent = await requireAgent(locale);
  const t = await getTranslations("dashboard");
  const sp = await searchParams;
  const tz = await agentTimeZone(agent);
  const period = (PERIOD_CHOICES as readonly string[]).includes(sp.period ?? "") ? (sp.period as PeriodEnd) : "now";
  const group = sp.group === "topic" || sp.group === "staff" ? sp.group : "dept";
  const range = reportRange(sp.start, period, tz);

  const [{ top, counts, all }, plot, table] = await Promise.all([agentQueueNav(agent), plotData(range), tabularData(group, agent, range)]);
  const kpi = (id: number) => (typeof counts.get(id) === "number" ? (counts.get(id) as number) : 0);
  const cards = [
    { label: t("kpi.open"), value: kpi(1), href: "/agent/tickets?queue=1" },
    { label: t("kpi.overdue"), value: kpi(4), href: "/agent/tickets?queue=4", tone: "text-error-500" },
    { label: t("kpi.mine"), value: kpi(5), href: "/agent/tickets?queue=5" },
    { label: t("kpi.closedToday"), value: kpi(9), href: "/agent/tickets?queue=9" },
  ].filter((c, i) => all.has([1, 4, 5, 9][i]));
  void top;

  const groupHref = (g: string) => `/agent?group=${g}${sp.start ? `&start=${sp.start}` : ""}&period=${period}`;
  const fmt = (n: number | null) => (n === null ? "—" : n.toFixed(1));

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold text-gray-800 dark:text-white/90">{t("welcome", { name: agent.name.full })}</h2>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {cards.map((c) => (
          <Link key={c.href} href={c.href} className="rounded-2xl border border-gray-200 bg-white p-5 hover:border-brand-300 dark:border-gray-800 dark:bg-white/3">
            <p className="text-theme-sm text-gray-500 dark:text-gray-400">{c.label}</p>
            <p className={cn("mt-2 text-title-sm font-bold text-gray-800 dark:text-white/90", c.tone)}>{c.value}</p>
          </Link>
        ))}
      </div>

      <ComponentCard title={t("activity")} desc={t("activityDesc")}>
        <form action="/agent" className="flex flex-wrap items-end gap-3 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-gray-500">{t("from")}</span>
            <input type="date" name="start" defaultValue={sp.start} className="h-10 rounded-lg border border-gray-200 bg-transparent px-3 dark:border-gray-800 dark:text-white/90" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-gray-500">{t("period")}</span>
            <select name="period" defaultValue={period} className="h-10 rounded-lg border border-gray-200 bg-transparent px-3 dark:border-gray-800 dark:bg-gray-900 dark:text-white/90">
              {PERIOD_CHOICES.map((p) => (
                <option key={p} value={p}>
                  {t(`periods.${p.replace(/[+ ]/g, "")}`)}
                </option>
              ))}
            </select>
          </label>
          <input type="hidden" name="group" value={group} />
          <button type="submit" className="h-10 rounded-lg bg-brand-500 px-4 text-white hover:bg-brand-600">
            {t("refresh")}
          </button>
        </form>
        {plot.days.length ? <EventsChart days={plot.days} series={plot.series.map((s) => ({ ...s, name: t.has(`eventNames.${s.name}`) ? t(`eventNames.${s.name}`) : s.name }))} /> : <p className="text-sm text-gray-500">{t("noData")}</p>}
      </ComponentCard>

      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {(["dept", "topic", "staff"] as const).map((g) => (
            <Link
              key={g}
              href={groupHref(g)}
              className={cn(
                "rounded-lg px-3 py-2 text-sm font-medium",
                g === group ? "bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-400" : "text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/5",
              )}
            >
              {t(`groups.${g}`)}
            </Link>
          ))}
        </div>
        <DataTable
          empty={t("noData")}
          columns={[
            { key: "label", label: t(`groups.${group}`) },
            { key: "opened", label: t("cols.opened") },
            { key: "assigned", label: t("cols.assigned") },
            { key: "overdue", label: t("cols.overdue") },
            { key: "closed", label: t("cols.closed") },
            { key: "reopened", label: t("cols.reopened") },
            { key: "deleted", label: t("cols.deleted") },
            { key: "service", label: t("cols.serviceTime") },
            { key: "response", label: t("cols.responseTime") },
          ]}
          rows={table.map((r) => ({
            key: r.key,
            cells: {
              label: r.label,
              opened: r.opened,
              assigned: r.assigned,
              overdue: r.overdue,
              closed: r.closed,
              reopened: r.reopened,
              deleted: r.deleted,
              service: fmt(r.serviceTime),
              response: fmt(r.responseTime),
            },
          }))}
        />
      </div>
    </div>
  );
}
