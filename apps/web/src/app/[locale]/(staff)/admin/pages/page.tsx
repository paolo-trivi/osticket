import { getTranslations, setRequestLocale } from "next-intl/server";

import { NewButton } from "@/components/adminsys/BackLink";
import SysNotice from "@/components/adminsys/SysNotice";
import MassBar from "@/components/admin/MassBar";
import DataTable, { PageHeader } from "@/components/common/DataTable";
import Badge from "@/components/ui/badge/Badge";
import { Link } from "@/i18n/navigation";
import { db } from "@/server/db";
import { listPages } from "@/server/domain/adminsys/page";

import { dateFormatter } from "../_sys/server";
import { requireAdmin } from "../guard";
import { massPageAction } from "./actions";
import { adminMetadata } from "../metadata";

export const generateMetadata = adminMetadata("pages");

/** Pagine del sito (include/staff/pages.inc.php). */
export default async function PagesPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string>> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const agent = await requireAdmin(locale);
  const t = await getTranslations("asys.pages");
  const c = await getTranslations("asys.common");
  const sp = await searchParams;
  const date = await dateFormatter(agent, locale);
  const pages = await listPages(db());
  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} subtitle={t("subtitle")} actions={<NewButton href="/admin/pages/new" label={t("new")} />} />
      <SysNotice sp={sp} />
      <form action={massPageAction} className="space-y-4">
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
            { key: "type", label: t("type") },
            { key: "status", label: t("status") },
            { key: "created", label: c("created") },
            { key: "updated", label: c("updated") },
          ]}
          rows={pages.map((p) => ({
            key: p.id,
            cells: {
              sel: <input type="checkbox" name="ids[]" value={p.id} className="h-4 w-4 accent-brand-500" aria-label={p.name} />,
              name: (
                <Link href={`/admin/pages/${p.id}`} className="font-medium text-brand-500 hover:text-brand-600">
                  {p.name}
                  {p.isDefault && <span className="ms-2 text-theme-xs text-gray-500">({c("default")})</span>}
                </Link>
              ),
              type: t(`types.${p.type}`),
              status: (
                <Badge size="sm" color={p.isactive ? "success" : "light"}>
                  {p.isactive ? c("active") : c("disabled")}
                  {p.isDefault || p.topics ? ` · ${t("inUse")}` : ""}
                </Badge>
              ),
              created: date(p.created, "date"),
              updated: date(p.updated),
            },
          }))}
        />
      </form>
    </div>
  );
}
