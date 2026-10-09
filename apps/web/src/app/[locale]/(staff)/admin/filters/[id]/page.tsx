import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import BackLink from "@/components/adminsys/BackLink";
import SysForm from "@/components/adminsys/SysForm";
import SysNotice from "@/components/adminsys/SysNotice";
import Callout from "@/components/common/Callout";
import { PageHeader } from "@/components/common/DataTable";
import { redirect } from "@/i18n/navigation";
import { db } from "@/server/db";
import { FilterFlag, filterInfo } from "@/server/domain/adminsys/filter";

import { requireAdmin } from "../../guard";
import { saveFilterAction } from "../actions";
import { FilterFields } from "../form";
import { filterLabels } from "../labels";

export default async function EditFilterPage({ params, searchParams }: { params: Promise<{ locale: string; id: string }>; searchParams: Promise<Record<string, string>> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  await requireAdmin(locale);
  const filterId = Number(id);
  const info = Number.isInteger(filterId) && filterId > 0 ? await filterInfo(db(), filterId) : null;
  if (!info) notFound();
  // la ban list ha la sua pagina (scp/filters.php → banlist.php)
  if (info.filter.name.toLowerCase() === "system ban list") redirect({ href: "/admin/banlist", locale });
  const t = await getTranslations("asys.filters");
  const c = await getTranslations("asys.common");
  const sp = await searchParams;
  const flags = info.filter.flags ?? 0;
  return (
    <div className="space-y-6">
      <PageHeader title={info.filter.name} subtitle={t("edit")} actions={<BackLink href="/admin/filters" label={c("back")} />} />
      <SysNotice sp={sp} />
      {flags & FilterFlag.DELETED_OBJECT ? <Callout tone="warning">{t("flags.deleted")}</Callout> : null}
      {flags & FilterFlag.INACTIVE_DEPT ? <Callout tone="warning">{t("flags.dept")}</Callout> : null}
      {flags & FilterFlag.INACTIVE_HT ? <Callout tone="warning">{t("flags.topic")}</Callout> : null}
      <SysForm action={saveFilterAction.bind(null, filterId)} labels={await filterLabels()}>
        <FilterFields info={info} />
      </SysForm>
    </div>
  );
}
