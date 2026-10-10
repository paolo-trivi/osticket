import { getTranslations, setRequestLocale } from "next-intl/server";

import { NewButton } from "@/components/adminsys/BackLink";
import SysNotice from "@/components/adminsys/SysNotice";
import MassBar from "@/components/admin/MassBar";
import DataTable, { PageHeader } from "@/components/common/DataTable";
import { Link } from "@/i18n/navigation";
import { DynamicList } from "@/lib/osticket/flags";
import { db } from "@/server/db";
import { listLists } from "@/server/domain/adminsys/list";

import { dateFormatter } from "../_sys/server";
import { requireAdmin } from "../guard";
import { massListAction } from "./actions";

/** Liste personalizzate (include/staff/dynamic-lists.inc.php). */
export default async function ListsPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string>> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const agent = await requireAdmin(locale);
  const t = await getTranslations("asys.lists");
  const c = await getTranslations("asys.common");
  const sp = await searchParams;
  const date = await dateFormatter(agent, locale);
  const lists = await listLists(db());
  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} subtitle={t("subtitle")} actions={<NewButton href="/admin/lists/new" label={t("new")} />} />
      <SysNotice sp={sp} />
      <form action={massListAction} className="space-y-4">
        <MassBar actions={[{ value: "delete", label: c("delete"), danger: true }]} />
        <DataTable
          empty={c("empty")}
          columns={[
            { key: "sel", label: "", className: "w-10" },
            { key: "name", label: t("name") },
            { key: "items", label: t("itemsCount") },
            { key: "sort", label: t("sortMode") },
            { key: "created", label: c("created") },
            { key: "updated", label: c("updated") },
          ]}
          rows={lists.map((l) => ({
            key: l.id,
            cells: {
              sel: <input type="checkbox" name="ids[]" value={l.id} disabled={!!(l.masks & DynamicList.MASK_DELETE)} className="h-4 w-4 accent-brand-500" aria-label={l.name} />,
              name: (
                <Link href={`/admin/lists/${l.id}`} className="font-medium text-brand-500 hover:text-brand-600">
                  {l.name}
                  {l.system && <span className="ms-2 text-theme-xs text-gray-500">({t("system")})</span>}
                </Link>
              ),
              items: l.items,
              sort: t(`sortModes.${l.sort_mode}`),
              created: date(l.created, "date"),
              updated: date(l.updated),
            },
          }))}
        />
      </form>
    </div>
  );
}
