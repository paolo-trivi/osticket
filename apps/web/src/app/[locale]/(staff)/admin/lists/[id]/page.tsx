import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import BackLink from "@/components/adminsys/BackLink";
import SysForm from "@/components/adminsys/SysForm";
import SysNotice from "@/components/adminsys/SysNotice";
import MassBar from "@/components/admin/MassBar";
import Callout from "@/components/common/Callout";
import DataTable, { PageHeader } from "@/components/common/DataTable";
import Badge from "@/components/ui/badge/Badge";
import { Link } from "@/i18n/navigation";
import { DynamicListItem } from "@/lib/osticket/flags";
import { db } from "@/server/db";
import { htmlDecode } from "@/server/format/html";
import { listDetail } from "@/server/domain/adminsys/list";

import { requireAdmin } from "../../guard";
import { massListItemAction, saveListAction, saveListItemAction } from "../actions";
import { ListFields } from "../form";
import { ItemFields } from "../items";

/** Lista: proprietà ed elementi (include/staff/dynamic-list.inc.php). */
export default async function ListPage({ params, searchParams }: { params: Promise<{ locale: string; id: string }>; searchParams: Promise<Record<string, string>> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  await requireAdmin(locale);
  const listId = Number(id);
  const detail = Number.isInteger(listId) && listId > 0 ? await listDetail(db(), listId) : null;
  if (!detail) notFound();
  const t = await getTranslations("asys.lists");
  const c = await getTranslations("asys.common");
  const sp = await searchParams;
  const unsupported = detail.properties.some((p) => !["text", "memo", "break", "info"].includes(p.type));
  return (
    <div className="space-y-6">
      <PageHeader title={htmlDecode(detail.list.name)} subtitle={t("edit")} actions={<BackLink href="/admin/lists" label={c("back")} />} />
      <SysNotice sp={sp} />
      {detail.system ? (
        <Callout tone="info">{t("systemNote")}</Callout>
      ) : (
        <>
          <SysForm action={saveListAction.bind(null, listId)} labels={{ name: t("name") }}>
            <ListFields detail={detail} />
          </SysForm>
          {unsupported && <Callout tone="warning">{t("unsupportedProps")}</Callout>}
          <SysForm action={saveListItemAction.bind(null, listId, null)} submitLabel={t("addItem")} savedMessage={t("itemAdded")} labels={{ value: t("value"), extra: t("abbrev") }} resetOnSave>
            <ItemFields item={null} properties={detail.properties} />
          </SysForm>
          <form action={massListItemAction.bind(null, listId)} className="space-y-4">
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
                { key: "value", label: t("value") },
                { key: "extra", label: t("abbrev") },
                { key: "sort", label: t("sort") },
                { key: "status", label: t("status") },
              ]}
              rows={detail.items.map((i) => ({
                key: i.id,
                cells: {
                  sel: <input type="checkbox" name="ids[]" value={i.id} disabled={!!(i.status & DynamicListItem.INTERNAL)} className="h-4 w-4 accent-brand-500" aria-label={i.value} />,
                  value: (
                    <Link href={`/admin/lists/${listId}/items/${i.id}`} className="font-medium text-brand-500 hover:text-brand-600">
                      {i.value}
                    </Link>
                  ),
                  extra: i.extra ?? "—",
                  sort: i.sort,
                  status: (
                    <Badge size="sm" color={i.status & DynamicListItem.ENABLED ? "success" : "light"}>
                      {i.status & DynamicListItem.ENABLED ? c("active") : c("disabled")}
                    </Badge>
                  ),
                },
              }))}
            />
          </form>
        </>
      )}
    </div>
  );
}
