import { getTranslations, setRequestLocale } from "next-intl/server";

import BackLink from "@/components/adminsys/BackLink";
import SysForm from "@/components/adminsys/SysForm";
import { PageHeader } from "@/components/common/DataTable";

import { requireAdmin } from "../../guard";
import { saveFilterAction } from "../actions";
import { FilterFields } from "../form";
import { filterLabels } from "../labels";
import { adminMetadata } from "../../metadata";

export const generateMetadata = adminMetadata("filters");

export default async function NewFilterPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireAdmin(locale);
  const t = await getTranslations("asys.filters");
  const c = await getTranslations("asys.common");
  return (
    <div className="space-y-6">
      <PageHeader title={t("new")} actions={<BackLink href="/admin/filters" label={c("back")} />} />
      <SysForm action={saveFilterAction.bind(null, null)} submitLabel={c("create")} labels={await filterLabels()}>
        <FilterFields info={null} />
      </SysForm>
    </div>
  );
}
