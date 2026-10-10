import { getTranslations, setRequestLocale } from "next-intl/server";

import BackLink from "@/components/adminsys/BackLink";
import SysForm from "@/components/adminsys/SysForm";
import { PageHeader } from "@/components/common/DataTable";

import { requireAdmin } from "../../guard";
import { savePageAction } from "../actions";
import { PageFields } from "../form";
import { adminMetadata } from "../../metadata";

export const generateMetadata = adminMetadata("pages");

export default async function NewSitePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireAdmin(locale);
  const t = await getTranslations("asys.pages");
  const c = await getTranslations("asys.common");
  return (
    <div className="space-y-6">
      <PageHeader title={t("new")} actions={<BackLink href="/admin/pages" label={c("back")} />} />
      <SysForm action={savePageAction.bind(null, null)} submitLabel={c("create")} labels={{ name: t("name"), type: t("type"), body: t("body"), isactive: t("status") }}>
        <PageFields page={null} />
      </SysForm>
    </div>
  );
}
