import { getTranslations, setRequestLocale } from "next-intl/server";

import { NewButton } from "@/components/adminsys/BackLink";
import SysNotice from "@/components/adminsys/SysNotice";
import MassBar from "@/components/admin/MassBar";
import DataTable, { PageHeader } from "@/components/common/DataTable";
import Badge from "@/components/ui/badge/Badge";
import { Link } from "@/i18n/navigation";
import { db } from "@/server/db";
import { listTemplateGroups } from "@/server/domain/adminsys/template";

import { dateFormatter } from "../_sys/server";
import { requireAdmin } from "../guard";
import { massTemplateAction } from "./actions";
import { adminMetadata } from "../metadata";

export const generateMetadata = adminMetadata("templates");

/** Set di template email (include/staff/templates.inc.php). */
export default async function TemplatesPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string>> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const agent = await requireAdmin(locale);
  const t = await getTranslations("asys.templates");
  const c = await getTranslations("asys.common");
  const sp = await searchParams;
  const date = await dateFormatter(agent, locale);
  const groups = await listTemplateGroups(db());
  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} subtitle={t("subtitle")} actions={<NewButton href="/admin/templates/new" label={t("new")} />} />
      <SysNotice sp={sp} />
      <form action={massTemplateAction} className="space-y-4">
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
            { key: "lang", label: t("language") },
            { key: "inuse", label: t("inUse") },
            { key: "created", label: c("created") },
            { key: "updated", label: c("updated") },
          ]}
          rows={groups.map((g) => ({
            key: g.tpl_id,
            cells: {
              sel: <input type="checkbox" name="ids[]" value={g.tpl_id} className="h-4 w-4 accent-brand-500" aria-label={g.name} />,
              name: (
                <Link href={`/admin/templates/${g.tpl_id}`} className="font-medium text-brand-500 hover:text-brand-600">
                  {g.name}
                  {g.isDefault && <span className="ms-2 text-theme-xs text-gray-500">({c("default")})</span>}
                </Link>
              ),
              status: (
                <Badge size="sm" color={g.isactive ? "success" : "light"}>
                  {g.isactive ? c("active") : c("disabled")}
                </Badge>
              ),
              lang: g.lang,
              inuse: g.isDefault || g.depts ? c("yes") : c("no"),
              created: date(g.created, "date"),
              updated: date(g.updated),
            },
          }))}
        />
      </form>
    </div>
  );
}
