import { getTranslations, setRequestLocale } from "next-intl/server";

import BackLink from "@/components/adminsys/BackLink";
import SysForm from "@/components/adminsys/SysForm";
import { PageHeader } from "@/components/common/DataTable";

import { requireAdmin } from "../../guard";
import { saveEmailAction } from "../actions";
import { EmailFields, emailLabels } from "../form";

export default async function NewEmailPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireAdmin(locale);
  const t = await getTranslations("asys.emails");
  const c = await getTranslations("asys.common");
  return (
    <div className="space-y-6">
      <PageHeader title={t("new")} actions={<BackLink href="/admin/emails" label={c("back")} />} />
      <SysForm action={saveEmailAction.bind(null, null)} labels={await emailLabels()} submitLabel={c("create")}>
        <EmailFields info={{ dept_id: "0", priority_id: "0", topic_id: "0" }} isNew />
      </SysForm>
    </div>
  );
}
