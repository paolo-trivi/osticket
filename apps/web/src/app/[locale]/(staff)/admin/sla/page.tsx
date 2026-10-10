import { getTranslations, setRequestLocale } from "next-intl/server";

import AdminList from "@/components/admin/AdminList";
import Badge from "@/components/ui/badge/Badge";
import { Link } from "@/i18n/navigation";
import { SLA } from "@/lib/osticket/flags";
import { coreConfig } from "@/server/config/config";
import { db } from "@/server/db";
import { htmlDecode } from "@/server/format/html";

import { requireAdmin } from "../guard";
import { massSlaAction } from "./actions";

/** Elenco piani SLA (include/staff/slaplans.inc.php). */
export default async function SlaPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string>> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireAdmin(locale);
  const t = await getTranslations("admSla");
  const u = await getTranslations("admUi");
  const sp = await searchParams;
  const defaultId = (await coreConfig()).int("default_sla_id");
  const rows = await db().selectFrom("sla").select(["id", "name", "flags", "grace_period", "updated"]).orderBy("name").execute();
  return (
    <AdminList
      title={t("title")}
      subtitle={t("subtitle")}
      newHref="/admin/sla/new"
      newLabel={t("new")}
      action={massSlaAction}
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
        { key: "grace", label: t("gracePeriod") },
        { key: "updated", label: t("updated") },
      ]}
      rows={rows.map((r) => ({
        id: r.id,
        label: htmlDecode(r.name),
        cells: {
          name: (
            <Link href={`/admin/sla/${r.id}`} className="font-medium text-brand-500 hover:text-brand-600">
              {htmlDecode(r.name)}
              {r.id === defaultId && <span className="ms-2 text-theme-xs text-gray-500">({u("default")})</span>}
            </Link>
          ),
          status: (
            <Badge size="sm" color={r.flags & SLA.ACTIVE ? "success" : "light"}>
              {r.flags & SLA.ACTIVE ? t("active") : t("disabled")}
            </Badge>
          ),
          grace: `${r.grace_period} h`,
          updated: String(r.updated ?? ""),
        },
      }))}
    />
  );
}
