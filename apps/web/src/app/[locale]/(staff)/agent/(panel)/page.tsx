import { getTranslations, setRequestLocale } from "next-intl/server";

import ComponentCard from "@/components/common/ComponentCard";
import DataTable from "@/components/common/DataTable";
import EventsChart from "@/components/dashboard/EventsChart";
import StatsFilter from "@/components/dashboard/StatsFilter";
import StatsTabs from "@/components/dashboard/StatsTabs";
import { Link } from "@/i18n/navigation";
import { agentQueueNav } from "@/server/domain/queue/context";
import {
  PERIOD_CHOICES,
  parseGroup,
  parsePeriod,
  plotData,
  reportRange,
  tabularData,
  TABULAR_GROUPS,
  type TabularGroup,
  type TabularRow,
} from "@/server/domain/stats/report";
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
  const ts = await getTranslations("stats");
  const sp = await searchParams;
  const tz = await agentTimeZone(agent);
  const period = parsePeriod(sp.period);
  const group = parseGroup(sp.group);
  const range = reportRange(sp.start, period, tz);

  // Tutte e tre le schede: servono i conteggi delle righe; la tabella mostra quella attiva
  const [{ top, counts, all }, plot, tables] = await Promise.all([
    agentQueueNav(agent),
    plotData(range, agent),
    Promise.all(TABULAR_GROUPS.map((g) => tabularData(g, agent, range))),
  ]);
  const rowsOf = Object.fromEntries(TABULAR_GROUPS.map((g, i) => [g, tables[i]])) as Record<TabularGroup, TabularRow[]>;
  const table = rowsOf[group];
  const kpi = (id: number) => (typeof counts.get(id) === "number" ? (counts.get(id) as number) : 0);
  const cards = [
    { label: t("kpi.open"), value: kpi(1), href: "/agent/tickets?queue=1" },
    { label: t("kpi.overdue"), value: kpi(4), href: "/agent/tickets?queue=4", tone: "text-error-500" },
    { label: t("kpi.mine"), value: kpi(5), href: "/agent/tickets?queue=5" },
    { label: t("kpi.closedToday"), value: kpi(9), href: "/agent/tickets?queue=9" },
  ].filter((c, i) => all.has([1, 4, 5, 9][i]));
  void top;

  // Stessi filtri per schede ed export (l'export rifà la stessa tabularData con questi parametri)
  const filters: Record<string, string> = { start: sp.start ? range.startDay : "", period };
  const query = (extra: Record<string, string>) =>
    new URLSearchParams(Object.entries({ ...extra, ...filters }).filter(([, v]) => v !== "")).toString();
  const hours = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const fmt = (n: number | null) => (n === null ? "—" : hours.format(n));
  // Giorni (yyyy-mm-dd, già nel fuso dell'agente) formattati senza ulteriori conversioni di fuso
  const dayFmt = new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" });
  const day = (iso: string) => dayFmt.format(Date.parse(`${iso}T00:00:00Z`));
  const rangeText = ts("range", { start: day(range.startDay), stop: day(range.lastDay), tz: range.zone });

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
        <StatsFilter start={range.startDay} period={period} periods={PERIOD_CHOICES} group={group} rangeText={rangeText} />
        {plot.days.length ? (
          <EventsChart days={plot.days} series={plot.series.map((s) => ({ ...s, name: t.has(`eventNames.${s.name}`) ? t(`eventNames.${s.name}`) : s.name }))} />
        ) : (
          <p className="text-sm text-gray-500 dark:text-gray-400">{t("noData")}</p>
        )}
      </ComponentCard>

      <StatsTabs
        active={group}
        tabs={TABULAR_GROUPS.map((g) => ({
          key: g,
          label: t(`groups.${g}`),
          count: rowsOf[g].length,
          countLabel: ts("rows", { count: rowsOf[g].length }),
          href: `/agent?${query({ group: g })}`,
        }))}
        exportHref={`/api/agent/stats/export?${query({ group, locale })}`}
        exportLabel={ts("export")}
        exportTitle={ts("exportTitle", { tab: t(`groups.${group}`) })}
      >
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
      </StatsTabs>
    </div>
  );
}
