import { sql } from "kysely";
import { getTranslations, setRequestLocale } from "next-intl/server";

import AdminNotice from "@/components/admin/AdminNotice";
import MassBar from "@/components/admin/MassBar";
import NewLink from "@/components/admin/NewLink";
import DataTable, { PageHeader } from "@/components/common/DataTable";
import Badge from "@/components/ui/badge/Badge";
import { Link } from "@/i18n/navigation";
import { Dept } from "@/lib/osticket/flags";
import { coreConfig } from "@/server/config/config";
import { db, table } from "@/server/db";
import { deptOptions } from "@/server/domain/admin/lookups";

import { requireAdmin } from "../guard";
import { massDeptAction } from "./actions";
import { adminMetadata } from "../metadata";

export const generateMetadata = adminMetadata("departments");

/** Elenco reparti (include/staff/departments.inc.php). */
export default async function DepartmentsPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string>> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireAdmin(locale);
  const t = await getTranslations("admDepts");
  const u = await getTranslations("admUi");
  const sp = await searchParams;
  const cfg = await coreConfig();
  const defaultId = cfg.int("default_dept_id");
  const names = new Map((await deptOptions()).map((d) => [d.value, d.label]));
  const { rows } = await sql<{
    id: number;
    flags: number;
    ispublic: number;
    members: number;
    manager: string | null;
  }>`
    SELECT d.id, d.flags, d.ispublic, (SELECT count(*) FROM ${table("staff")} s WHERE s.dept_id = d.id) AS members,
      (SELECT CONCAT_WS(' ', m.firstname, m.lastname) FROM ${table("staff")} m WHERE m.staff_id = d.manager_id) AS manager
    FROM ${table("department")} d`.execute(db());
  const list = rows.map((r) => ({ ...r, name: names.get(String(r.id)) ?? "" })).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} subtitle={t("subtitle")} actions={<NewLink href="/admin/departments/new" label={t("new")} />} />
      <AdminNotice ok={sp.ok} n={sp.n} err={sp.err} />
      <form action={massDeptAction} className="space-y-4">
        <MassBar
          actions={[
            { value: "enable", label: u("enable") },
            { value: "disable", label: u("disable") },
            { value: "archive", label: u("archive") },
            { value: "delete", label: u("delete"), danger: true },
          ]}
        />
        <DataTable
          empty={u("empty")}
          columns={[
            { key: "sel", label: "", className: "w-10" },
            { key: "name", label: t("name") },
            { key: "status", label: t("status") },
            { key: "type", label: t("type") },
            { key: "members", label: t("membersCount") },
            { key: "manager", label: t("manager") },
          ]}
          rows={[
            ...list.map((d) => ({
              key: d.id,
              cells: {
                sel: <input type="checkbox" name="ids[]" value={d.id} className="h-4 w-4 accent-brand-500" aria-label={d.name} />,
                name: (
                  <Link href={`/admin/departments/${d.id}`} className="font-medium text-brand-500 hover:text-brand-600">
                    {d.name}
                    {d.id === defaultId && <span className="ms-2 text-theme-xs text-gray-500">({u("default")})</span>}
                  </Link>
                ),
                status: (
                  <Badge size="sm" color={d.flags & Dept.ACTIVE ? "success" : d.flags & Dept.ARCHIVED ? "warning" : "light"}>
                    {u(`status.${d.flags & Dept.ACTIVE ? "active" : d.flags & Dept.ARCHIVED ? "archived" : "disabled"}`)}
                  </Badge>
                ),
                type: d.ispublic ? t("public") : t("private"),
                members: Number(d.members),
                manager: d.manager ?? "—",
              },
            })),
          ]}
        />
      </form>
    </div>
  );
}
