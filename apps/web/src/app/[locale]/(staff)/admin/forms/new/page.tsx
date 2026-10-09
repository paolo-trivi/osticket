import { getTranslations, setRequestLocale } from "next-intl/server";

import BackLink from "@/components/adminsys/BackLink";
import SysForm from "@/components/adminsys/SysForm";
import { PageHeader } from "@/components/common/DataTable";

import { requireAdmin } from "../../guard";
import { saveFormAction } from "../actions";
import { FormFields, formLabels } from "../form";

export default async function NewFormPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireAdmin(locale);
  const t = await getTranslations("asys.forms");
  const c = await getTranslations("asys.common");
  return (
    <div className="space-y-6">
      <PageHeader title={t("new")} actions={<BackLink href="/admin/forms" label={c("back")} />} />
      <SysForm action={saveFormAction.bind(null, null)} submitLabel={c("create")} labels={await formLabels([])}>
        <FormFields detail={null} />
      </SysForm>
    </div>
  );
}
