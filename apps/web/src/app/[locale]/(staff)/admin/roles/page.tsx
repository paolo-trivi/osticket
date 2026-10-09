import { getTranslations, setRequestLocale } from "next-intl/server";

import AdminList from "@/components/admin/AdminList";
import Badge from "@/components/ui/badge/Badge";
import { Link } from "@/i18n/navigation";
import { db } from "@/server/db";
import { RoleFlag } from "@/server/domain/admin/role";

import { requireAdmin } from "../guard";
import { massRolesAction } from "./actions";

/** Elenco ruoli (include/staff/roles.inc.php). */
export default async function RolesPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string>> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireAdmin(locale);
  const t = await getTranslations("admRoles");
  const u = await getTranslations("admUi");
  const sp = await searchParams;
  const rows = await db().selectFrom("role").select(["id", "name", "flags", "created", "updated"]).orderBy("name").execute();
  return (
    <AdminList
      title={t("title")}
      subtitle={t("subtitle")}
      newHref="/admin/roles/new"
      newLabel={t("new")}
      action={massRolesAction}
      notice={sp}
      empty={u("empty")}
      actions={[
        { value: "enable", label: u("enable") },
        { value: "disable", label: u("disable") },
        { value: "delete", label: u("delete"), danger: true },
      ]}
      columns={[
        { key: "name", label: t("name") },
        { key: "status", label: t("status") },
        { key: "created", label: t("created") },
        { key: "updated", label: t("updated") },
      ]}
      rows={rows.map((r) => ({
        id: r.id,
        label: r.name ?? "",
        cells: {
          name: (
            <Link href={`/admin/roles/${r.id}`} className="font-medium text-brand-500 hover:text-brand-600">
              {r.name}
            </Link>
          ),
          status: (
            <Badge size="sm" color={r.flags & RoleFlag.ENABLED ? "success" : "light"}>
              {r.flags & RoleFlag.ENABLED ? u("status.active") : u("status.disabled")}
            </Badge>
          ),
          created: String(r.created),
          updated: String(r.updated),
        },
      }))}
    />
  );
}
