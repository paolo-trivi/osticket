import { getTranslations, setRequestLocale } from "next-intl/server";

import BackLink from "@/components/adminsys/BackLink";
import SysForm from "@/components/adminsys/SysForm";
import { PageHeader } from "@/components/common/DataTable";

import { requireAdmin } from "../../guard";
import { saveListAction } from "../actions";
import { ListFields } from "../form";

export default async function NewListPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireAdmin(locale);
  const t = await getTranslations("asys.lists");
  const c = await getTranslations("asys.common");
  return (
    <div className="space-y-6">
      <PageHeader title={t("new")} actions={<BackLink href="/admin/lists" label={c("back")} />} />
      <SysForm action={saveListAction.bind(null, null)} submitLabel={c("create")} labels={{ name: t("name") }}>
        <ListFields detail={null} />
      </SysForm>
    </div>
  );
}
