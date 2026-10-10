import { getTranslations, setRequestLocale } from "next-intl/server";

import { NewButton } from "@/components/adminsys/BackLink";
import SysNotice from "@/components/adminsys/SysNotice";
import MassBar from "@/components/admin/MassBar";
import DataTable, { PageHeader } from "@/components/common/DataTable";
import Badge from "@/components/ui/badge/Badge";
import { Link } from "@/i18n/navigation";
import { db } from "@/server/db";
import { listFilters } from "@/server/domain/adminsys/filter";

import { dateFormatter } from "../_sys/server";
import { requireAdmin } from "../guard";
import { massFilterAction } from "./actions";
import { adminMetadata } from "../metadata";

export const generateMetadata = adminMetadata("filters");

/** Filtri dei ticket (include/staff/filters.inc.php). */
export default async function FiltersPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string>> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const agent = await requireAdmin(locale);
  const t = await getTranslations("asys.filters");
  const c = await getTranslations("asys.common");
  const sp = await searchParams;
  const date = await dateFormatter(agent, locale);
  const rows = await listFilters(db());
  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} subtitle={t("subtitle")} actions={<NewButton href="/admin/filters/new" label={t("new")} />} />
      <SysNotice sp={sp} />
      <form action={massFilterAction} className="space-y-4">
        <MassBar
          actions={[
            { value: "enable", label: c("enable") },
            { value: "disable", label: c("disable") },
            { value: "delete", label: c("delete"), danger: true },
          ]}
        />
        <DataTable
          empty={c("empty")}
          columns={[
            { key: "sel", label: "", className: "w-10" },
            { key: "name", label: t("name") },
            { key: "status", label: t("status") },
            { key: "order", label: t("order") },
            { key: "rules", label: t("rules") },
            { key: "target", label: t("target") },
            { key: "created", label: c("created") },
            { key: "updated", label: c("updated") },
          ]}
          rows={rows.map((f) => {
            const banlist = f.name.toLowerCase() === "system ban list";
            return {
              key: f.id,
              cells: {
                sel: <input type="checkbox" name="ids[]" value={f.id} className="h-4 w-4 accent-brand-500" aria-label={f.name} />,
                name: (
                  <Link href={banlist ? "/admin/banlist" : `/admin/filters/${f.id}`} className="font-medium text-brand-500 hover:text-brand-600">
                    {f.name}
                  </Link>
                ),
                status: (
                  <Badge size="sm" color={f.isactive ? "success" : "light"}>
                    {f.isactive ? c("active") : c("disabled")}
                  </Badge>
                ),
                order: f.execorder,
                rules: Number(f.rules),
                target: t(`targets.${f.target}`),
                created: date(f.created, "date"),
                updated: date(f.updated),
              },
            };
          })}
        />
      </form>
    </div>
  );
}
