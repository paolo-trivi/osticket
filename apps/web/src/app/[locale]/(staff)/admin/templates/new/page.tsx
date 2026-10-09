import { getTranslations, setRequestLocale } from "next-intl/server";

import BackLink from "@/components/adminsys/BackLink";
import SysForm from "@/components/adminsys/SysForm";
import { PageHeader } from "@/components/common/DataTable";
import { db } from "@/server/db";
import { templateOptions } from "@/server/domain/admin/lookups";

import { requireAdmin } from "../../guard";
import { addTemplateGroupAction } from "../actions";
import { TemplateGroupFields } from "../fields";

export default async function NewTemplateSetPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireAdmin(locale);
  const t = await getTranslations("asys.templates");
  const c = await getTranslations("asys.common");
  return (
    <div className="space-y-6">
      <PageHeader title={t("new")} actions={<BackLink href="/admin/templates" label={c("back")} />} />
      <SysForm action={addTemplateGroupAction} submitLabel={c("create")} labels={{ name: t("name"), tpl_id: t("cloneFrom") }}>
        <TemplateGroupFields group={null} sets={await templateOptions(db())} />
      </SysForm>
    </div>
  );
}
