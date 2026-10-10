import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import BackLink from "@/components/adminsys/BackLink";
import PhpLink from "@/components/adminsys/PhpLink";
import SysForm from "@/components/adminsys/SysForm";
import SysNotice from "@/components/adminsys/SysNotice";
import Callout from "@/components/common/Callout";
import { PageHeader } from "@/components/common/DataTable";
import { FormType } from "@/lib/osticket/object-types";
import { idOrNotFound } from "@/lib/route-id";
import { db } from "@/server/db";
import { formDetail } from "@/server/domain/adminsys/form";

import { requireAdmin } from "../../guard";
import { saveFormAction } from "../actions";
import { FormFields, formLabels } from "../form";
import { adminMetadata } from "../../metadata";

export const generateMetadata = adminMetadata("forms");

export default async function EditFormPage({ params, searchParams }: { params: Promise<{ locale: string; id: string }>; searchParams: Promise<Record<string, string>> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  await requireAdmin(locale);
  const formId = idOrNotFound(id);
  const detail = await formDetail(db(), formId);
  if (!detail || detail.form.type.startsWith(FormType.LIST_PREFIX)) notFound();
  const t = await getTranslations("asys.forms");
  const c = await getTranslations("asys.common");
  const sp = await searchParams;
  return (
    <div className="space-y-6">
      <PageHeader title={detail.form.title} subtitle={t("edit")} actions={<BackLink href="/admin/forms" label={c("back")} />} />
      <SysNotice sp={sp} />
      <Callout tone="info">
        {t("configNote")} <PhpLink path={`/scp/forms.php?id=${formId}`} label={t("openPhp")} />
      </Callout>
      <SysForm action={saveFormAction.bind(null, formId)} labels={await formLabels(detail.fields.map((f) => f.id))}>
        <FormFields detail={detail} />
      </SysForm>
    </div>
  );
}
