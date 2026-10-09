import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import BackLink from "@/components/adminsys/BackLink";
import SysForm from "@/components/adminsys/SysForm";
import SysNotice from "@/components/adminsys/SysNotice";
import { PageHeader } from "@/components/common/DataTable";
import { db } from "@/server/db";
import { formDetail } from "@/server/domain/adminsys/form";

import { requireAdmin } from "../../guard";
import { saveFormAction } from "../actions";
import { FormFields, formLabels } from "../form";

export default async function EditFormPage({ params, searchParams }: { params: Promise<{ locale: string; id: string }>; searchParams: Promise<Record<string, string>> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  await requireAdmin(locale);
  const formId = Number(id);
  const detail = Number.isInteger(formId) && formId > 0 ? await formDetail(db(), formId) : null;
  if (!detail || detail.form.type.startsWith("L")) notFound();
  const t = await getTranslations("asys.forms");
  const c = await getTranslations("asys.common");
  const sp = await searchParams;
  return (
    <div className="space-y-6">
      <PageHeader title={detail.form.title} subtitle={t("edit")} actions={<BackLink href="/admin/forms" label={c("back")} />} />
      <SysNotice sp={sp} />
      <SysForm action={saveFormAction.bind(null, formId)} labels={await formLabels(detail.fields.map((f) => f.id))}>
        <FormFields detail={detail} />
      </SysForm>
    </div>
  );
}
