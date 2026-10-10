import { sql } from "kysely";
import { getTranslations, setRequestLocale } from "next-intl/server";

import AdminList from "@/components/admin/AdminList";
import Badge from "@/components/ui/badge/Badge";
import { Link } from "@/i18n/navigation";
import { coreConfig } from "@/server/config/config";
import { db, table } from "@/server/db";
import { deptOptions, roleOptions } from "@/server/domain/admin/lookups";
import { AGENT_PERMISSIONS } from "@/server/domain/admin/staff-admin";
import { agentTimeZone, formatDbDate } from "@/server/format/datetime";
import { PersonsName } from "@/server/format/persons-name";

import { requireAdmin } from "../guard";
import { permLabel } from "../roles/perm-label";
import { massAgentsAction } from "./actions";
import { adminMetadata } from "../metadata";

export const generateMetadata = adminMetadata("agentsList");

const control = "h-9 rounded-lg border border-gray-300 bg-transparent px-3 text-sm dark:border-gray-700 dark:bg-gray-900 dark:text-white/90";
const button =
  "rounded-lg px-3 py-2 text-sm font-medium text-gray-700 ring-1 ring-gray-300 ring-inset hover:bg-gray-50 dark:text-gray-300 dark:ring-gray-700 dark:hover:bg-white/5";

/** Elenco agenti (include/staff/staffmembers.inc.php) con le azioni di massa di scp/staff.php. */
export default async function AgentsPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string>> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const admin = await requireAdmin(locale);
  const tz = await agentTimeZone(admin);
  const t = await getTranslations("admAgents");
  const u = await getTranslations("admUi");
  const roleT = await getTranslations("admRoles");
  const sp = await searchParams;
  const fmt = (await coreConfig()).str("agent_name_format");
  const depts = await deptOptions();
  const deptName = new Map(depts.map((d) => [d.value, d.label]));
  const roles = await roleOptions();
  const { rows } = await sql<{
    staff_id: number;
    firstname: string | null;
    lastname: string | null;
    username: string;
    dept_id: number;
    isactive: number;
    isadmin: number;
    onvacation: number;
    lastlogin: string | null;
  }>`SELECT staff_id, firstname, lastname, username, dept_id, isactive, isadmin, onvacation, lastlogin FROM ${table("staff")} ORDER BY firstname, lastname`.execute(db());
  return (
    <AdminList
      title={t("title")}
      subtitle={t("subtitle")}
      newHref="/admin/agents/new"
      newLabel={t("new")}
      action={massAgentsAction}
      notice={sp}
      empty={u("empty")}
      actions={[
        { value: "enable", label: t("activate") },
        { value: "disable", label: t("lock") },
        { value: "delete", label: u("delete"), danger: true },
      ]}
      columns={[
        { key: "name", label: t("name") },
        { key: "username", label: t("username") },
        { key: "dept", label: t("primaryDept") },
        { key: "status", label: t("status") },
        { key: "lastlogin", label: t("lastLogin") },
      ]}
      rows={rows.map((r) => {
        const name = new PersonsName({ first: r.firstname ?? "", last: r.lastname ?? "" }, fmt).toString();
        return {
          id: r.staff_id,
          label: name,
          cells: {
            name: (
              <Link href={`/admin/agents/${r.staff_id}`} className="font-medium text-brand-500 hover:text-brand-600">
                {name}
              </Link>
            ),
            username: r.username,
            dept: deptName.get(String(r.dept_id)) ?? "—",
            status: (
              <span className="flex flex-wrap gap-1">
                <Badge size="sm" color={r.isactive ? "success" : "error"}>
                  {r.isactive ? t("active") : t("locked")}
                </Badge>
                {!!r.isadmin && (
                  <Badge size="sm" color="primary">
                    {t("admin")}
                  </Badge>
                )}
                {!!r.onvacation && (
                  <Badge size="sm" color="warning">
                    {t("onVacation")}
                  </Badge>
                )}
              </span>
            ),
            lastlogin: formatDbDate(r.lastlogin, tz, locale) || "—",
          },
        };
      })}
      extra={
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <details className="rounded-2xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-white/3">
            <summary className="cursor-pointer text-sm font-medium text-gray-800 dark:text-white/90">{t("massPerms")}</summary>
            <div className="mt-3 grid grid-cols-1 gap-2">
              {AGENT_PERMISSIONS.map((p) => (
                <label key={p.key} className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
                  <input type="checkbox" name="perms[]" value={p.key} className="mt-0.5 h-4 w-4 accent-brand-500" />
                  {permLabel(roleT, p)}
                </label>
              ))}
              <div>
                <button type="submit" name="a" value="permissions" className={button}>
                  {t("applyPerms")}
                </button>
              </div>
            </div>
          </details>
          <details className="rounded-2xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-white/3">
            <summary className="cursor-pointer text-sm font-medium text-gray-800 dark:text-white/90">{t("massDept")}</summary>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <select name="dept_id" className={control} aria-label={t("primaryDept")} defaultValue="">
                <option value="">{t("chooseDept")}</option>
                {depts.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>
              <select name="role_id" className={control} aria-label={t("primaryRole")} defaultValue="">
                <option value="">{t("chooseRole")}</option>
                {roles.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input type="checkbox" name="eavesdrop" value="1" className="h-4 w-4 accent-brand-500" />
                {t("eavesdrop")}
              </label>
              <button type="submit" name="a" value="department" className={button}>
                {t("applyDept")}
              </button>
            </div>
          </details>
        </div>
      }
    />
  );
}
