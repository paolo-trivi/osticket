import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import BackLink from "@/components/adminsys/BackLink";
import SysForm from "@/components/adminsys/SysForm";
import { PageHeader } from "@/components/common/DataTable";
import { db } from "@/server/db";
import { listDetail } from "@/server/domain/adminsys/list";

import { requireAdmin } from "../../../../guard";
import { saveListItemAction } from "../../../actions";
import { ItemFields } from "../../../items";

export default async function ListItemPage({ params }: { params: Promise<{ locale: string; id: string; itemId: string }> }) {
  const { locale, id, itemId } = await params;
  setRequestLocale(locale);
  await requireAdmin(locale);
  const listId = Number(id);
  const detail = Number.isInteger(listId) && listId > 0 ? await listDetail(db(), listId) : null;
  const item = detail?.items.find((i) => i.id === Number(itemId));
  if (!detail || !item) notFound();
  const t = await getTranslations("asys.lists");
  return (
    <div className="space-y-6">
      <PageHeader title={item.value} subtitle={t("editItem")} actions={<BackLink href={`/admin/lists/${listId}`} label={t("backToList")} />} />
      <SysForm action={saveListItemAction.bind(null, listId, item.id)} labels={{ value: t("value"), extra: t("abbrev") }}>
        <ItemFields item={item} properties={detail.properties} />
      </SysForm>
    </div>
  );
}
