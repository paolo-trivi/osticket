import { getTranslations, setRequestLocale } from "next-intl/server";

import AdminList from "@/components/admin/AdminList";
import Badge from "@/components/ui/badge/Badge";
import { Link } from "@/i18n/navigation";
import { Topic } from "@/lib/osticket/flags";
import { coreConfig } from "@/server/config/config";
import { db } from "@/server/db";
import { deptOptions, priorityOptions } from "@/server/domain/admin/lookups";
import { helpTopicsSnapshot, sortByName } from "@/server/domain/admin/topic";

import { dateFormatter } from "../_sys/server";
import { requireAdmin } from "../guard";
import { massTopicsAction } from "./actions";
import { adminMetadata } from "../metadata";

export const generateMetadata = adminMetadata("topics");

/** Elenco help topic (include/staff/helptopics.inc.php) con ordinamento alfabetico o manuale. */
export default async function TopicsPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string>> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const date = await dateFormatter(await requireAdmin(locale), locale);
  const t = await getTranslations("admTopics");
  const u = await getTranslations("admUi");
  const sp = await searchParams;
  const cfg = await coreConfig();
  const mode = cfg.str("help_topic_sort_mode") || "a";
  const defaultId = cfg.int("default_help_topic");
  const snapshot = await helpTopicsSnapshot(db());
  const rows = await db().selectFrom("help_topic").select(["topic_id", "flags", "ispublic", "dept_id", "priority_id", "sort", "created", "updated"]).execute();
  const byId = new Map(rows.map((r) => [r.topic_id, r]));
  const depts = new Map((await deptOptions()).map((d) => [d.value, d.label]));
  const priorities = new Map((await priorityOptions()).map((p) => [p.value, p.label]));
  // helptopics.inc.php: senza reparto o priorità propri mostra quelli predefiniti di sistema
  const defaultDept = depts.get(cfg.str("default_dept_id"));
  const defaultPriority = priorities.get(cfg.str("default_priority_id"));
  const list = mode === "a" ? sortByName(snapshot, cfg.str("system_language")) : [...snapshot].sort((a, b) => (byId.get(a.id)?.sort ?? 0) - (byId.get(b.id)?.sort ?? 0));
  const statusOf = (f: number) => (f & Topic.ACTIVE ? "active" : f & Topic.ARCHIVED ? "archived" : "disabled");
  return (
    <AdminList
      title={t("title")}
      subtitle={t("subtitle")}
      newHref="/admin/topics/new"
      newLabel={t("new")}
      action={massTopicsAction}
      notice={sp}
      empty={u("empty")}
      actions={[
        { value: "enable", label: u("enable") },
        { value: "disable", label: u("disable") },
        { value: "archive", label: u("archive") },
        { value: "delete", label: u("delete"), danger: true },
      ]}
      columns={[
        { key: "name", label: t("topic") },
        { key: "status", label: t("status") },
        { key: "type", label: t("type") },
        { key: "priority", label: t("priority") },
        { key: "dept", label: t("dept") },
        { key: "updated", label: u("updatedCol") },
        { key: "created", label: u("createdCol") },
        ...(mode === "m" ? [{ key: "sort", label: t("sortOrder"), className: "w-28" }] : []),
      ]}
      rows={list.map((x, i) => {
        const r = byId.get(x.id)!;
        const st = statusOf(r.flags ?? 0);
        return {
          id: x.id,
          label: x.name,
          cells: {
            name: (
              <Link href={`/admin/topics/${x.id}`} className="font-medium text-brand-500 hover:text-brand-600">
                {x.name}
                {x.id === defaultId && <span className="ms-2 text-theme-xs text-gray-500">({u("default")})</span>}
              </Link>
            ),
            status: (
              <Badge size="sm" color={st === "active" ? "success" : st === "archived" ? "warning" : "light"}>
                {u(`status.${st}`)}
              </Badge>
            ),
            type: r.ispublic ? t("public") : t("private"),
            priority: (r.priority_id ? priorities.get(String(r.priority_id)) : defaultPriority) ?? "—",
            dept: (r.dept_id ? depts.get(String(r.dept_id)) : defaultDept) ?? "—",
            // Format::datetime per entrambe le colonne, come helptopics.inc.php
            updated: date(r.updated),
            created: date(r.created),
            sort: (
              <input
                type="number"
                name={`sort-${x.id}`}
                // helptopics.inc.php: `$topic->sort ?: $sort` (posizione corrente se l'ordine è 0)
                defaultValue={r.sort || i + 1}
                className="h-9 w-20 rounded-lg border border-gray-300 bg-transparent px-2 text-sm dark:border-gray-700 dark:text-white/90"
                aria-label={t("sortOrder")}
              />
            ),
          },
        };
      })}
      extra={
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-white/3">
          <label className="text-sm text-gray-700 dark:text-gray-300" htmlFor="sort-mode">
            {t("sortMode")}
          </label>
          <select
            id="sort-mode"
            name="help_topic_sort_mode"
            defaultValue={mode}
            className="h-9 rounded-lg border border-gray-300 bg-transparent px-3 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-white/90"
          >
            <option value="a">{t("sortAlpha")}</option>
            <option value="m">{t("sortManual")}</option>
          </select>
          <button type="submit" name="a" value="sort" className="rounded-lg px-3 py-2 text-sm font-medium text-gray-700 ring-1 ring-gray-300 ring-inset hover:bg-gray-50 dark:text-gray-300 dark:ring-gray-700 dark:hover:bg-white/5">
            {t("saveSort")}
          </button>
        </div>
      }
    />
  );
}
