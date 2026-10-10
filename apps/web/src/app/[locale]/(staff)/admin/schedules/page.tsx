import { sql } from "kysely";
import { getTranslations, setRequestLocale } from "next-intl/server";

import AdminList from "@/components/admin/AdminList";
import { Link } from "@/i18n/navigation";
import { Schedule } from "@/lib/osticket/flags";
import { db, table } from "@/server/db";

import { dateFormatter } from "../_sys/server";
import { requireAdmin } from "../guard";
import { massSchedulesAction } from "./actions";
import { adminMetadata } from "../metadata";

export const generateMetadata = adminMetadata("schedules");

/** Elenco orari (include/staff/schedules.inc.php). */
export default async function SchedulesPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string>> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const date = await dateFormatter(await requireAdmin(locale), locale);
  const t = await getTranslations("admSchedules");
  const u = await getTranslations("admUi");
  const sp = await searchParams;
  const { rows } = await sql<{
    id: number;
    name: string;
    flags: number;
    timezone: string | null;
    entries: number;
    updated: string;
  }>`
    SELECT s.id, s.name, s.flags, s.timezone, s.updated, (SELECT count(*) FROM ${table("schedule_entry")} e WHERE e.schedule_id = s.id) AS entries
    FROM ${table("schedule")} s ORDER BY s.name`.execute(db());
  return (
    <AdminList
      title={t("title")}
      subtitle={t("subtitle")}
      newHref="/admin/schedules/new"
      newLabel={t("new")}
      action={massSchedulesAction}
      notice={sp}
      empty={u("empty")}
      actions={[{ value: "delete", label: u("delete"), danger: true }]}
      columns={[
        { key: "name", label: t("name") },
        { key: "type", label: t("type") },
        { key: "tz", label: t("timezone") },
        { key: "entries", label: t("entries") },
        { key: "updated", label: t("updated") },
      ]}
      rows={rows.map((r) => ({
        id: r.id,
        label: r.name,
        cells: {
          name: (
            <Link href={`/admin/schedules/${r.id}`} className="font-medium text-brand-500 hover:text-brand-600">
              {r.name}
            </Link>
          ),
          type: r.flags & Schedule.BIZHRS ? t("bizhrs") : t("hdays"),
          tz: r.timezone || t("floating"),
          entries: Number(r.entries),
          updated: date(r.updated),
        },
      }))}
    />
  );
}
