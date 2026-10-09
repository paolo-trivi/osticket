import { getTranslations, setRequestLocale } from "next-intl/server";

import { Callout, controlClass } from "@/components/adminsys/fields";
import SysNotice from "@/components/adminsys/SysNotice";
import MassBar from "@/components/admin/MassBar";
import LinkPager from "@/components/common/LinkPager";
import DataTable, { PageHeader } from "@/components/common/DataTable";
import Badge from "@/components/ui/badge/Badge";
import { db } from "@/server/db";
import { listLogs, LOG_TYPES } from "@/server/domain/adminsys/logs";
import { cn } from "@/utils";

import { dateFormatter } from "../_sys/server";
import { requireAdmin } from "../guard";
import { deleteLogsAction } from "./actions";

/** Log di sistema (include/staff/syslogs.inc.php). */
export default async function LogsPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string>> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const agent = await requireAdmin(locale);
  const t = await getTranslations("asys.logs");
  const c = await getTranslations("asys.common");
  const sp = await searchParams;
  const date = await dateFormatter(agent, locale);
  const res = await listLogs(db(), { type: sp.type, startDate: sp.startDate, endDate: sp.endDate, sort: sp.sort, order: sp.order, page: Number(sp.p) || 1 });
  const qs = new URLSearchParams(Object.entries({ type: sp.type, startDate: sp.startDate, endDate: sp.endDate, sort: sp.sort, order: sp.order }).filter(([, v]) => v) as [string, string][]);
  const query = qs.toString() ? `?${qs}` : "";
  const sortHref = (key: string) => {
    const q = new URLSearchParams(qs);
    q.set("sort", key);
    q.set("order", sp.sort === key && (sp.order ?? "DESC").toUpperCase() === "DESC" ? "ASC" : "DESC");
    return `/admin/logs?${q}`;
  };
  const sorted = (key: string) => ((sp.sort ?? "id") === key ? ((sp.order ?? "DESC").toUpperCase() === "ASC" ? "asc" : "desc") : undefined);
  const color = (lt: string) => (lt === "Error" ? "error" : lt === "Warning" ? "warning" : "light");
  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} subtitle={res.type ? t(`types.${res.type}`) : t("all")} />
      <SysNotice sp={sp} />
      {res.invalid && <Callout tone="warning">{t("invalidSpan")}</Callout>}
      <form method="get" className="flex flex-wrap items-end gap-3">
        <label className="text-sm text-gray-600 dark:text-gray-400">
          {t("from")}
          <input type="date" name="startDate" defaultValue={sp.startDate ?? ""} className={cn(controlClass, "mt-1 h-10 w-44")} />
        </label>
        <label className="text-sm text-gray-600 dark:text-gray-400">
          {t("to")}
          <input type="date" name="endDate" defaultValue={sp.endDate ?? ""} className={cn(controlClass, "mt-1 h-10 w-44")} />
        </label>
        <label className="text-sm text-gray-600 dark:text-gray-400">
          {t("type")}
          <select name="type" defaultValue={sp.type ?? ""} className={cn(controlClass, "mt-1 h-10 w-44 py-0")}>
            <option value="">{t("all")}</option>
            {LOG_TYPES.map((lt) => (
              <option key={lt} value={lt}>
                {t(`types.${lt}`)}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="h-10 rounded-lg px-4 text-sm font-medium text-gray-700 ring-1 ring-gray-300 ring-inset hover:bg-gray-50 dark:text-gray-300 dark:ring-gray-700 dark:hover:bg-white/5">
          {c("search")}
        </button>
      </form>
      <form action={deleteLogsAction.bind(null, query)} className="space-y-4">
        <MassBar actions={[{ value: "delete", label: c("delete"), danger: true }]} />
        <DataTable
          empty={c("empty")}
          columns={[
            { key: "sel", label: "", className: "w-10" },
            { key: "title", label: t("logTitle"), sortHref: sortHref("title"), sorted: sorted("title") },
            { key: "type", label: t("type"), sortHref: sortHref("type"), sorted: sorted("type") },
            { key: "date", label: t("date"), sortHref: sortHref("date"), sorted: sorted("date") },
            { key: "ip", label: t("ip"), sortHref: sortHref("ip"), sorted: sorted("ip") },
          ]}
          rows={res.rows.map((l) => ({
            key: l.log_id,
            cells: {
              sel: <input type="checkbox" name="ids[]" value={l.log_id} className="h-4 w-4 accent-brand-500" aria-label={l.title} />,
              title: (
                <details>
                  <summary className="cursor-pointer font-medium text-gray-800 dark:text-white/90">{l.title}</summary>
                  <pre className="mt-2 max-w-3xl text-theme-xs whitespace-pre-wrap text-gray-600 dark:text-gray-400">{l.log}</pre>
                </details>
              ),
              type: (
                <Badge size="sm" color={color(l.log_type)}>
                  {t(`types.${l.log_type}`)}
                </Badge>
              ),
              date: date(l.created),
              ip: l.ip_address,
            },
          }))}
        />
      </form>
      <LinkPager
        page={res.page}
        totalPages={Math.max(1, Math.ceil(res.total / res.limit))}
        href={(p: number) => `/admin/logs?${new URLSearchParams({ ...Object.fromEntries(qs), p: String(p) })}`}
        labels={{ prev: c("prev"), next: c("next") }}
      />
    </div>
  );
}
