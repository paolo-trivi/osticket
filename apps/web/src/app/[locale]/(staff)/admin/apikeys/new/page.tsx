import { getTranslations, setRequestLocale } from "next-intl/server";

import BackLink from "@/components/adminsys/BackLink";
import SysForm from "@/components/adminsys/SysForm";
import { PageHeader } from "@/components/common/DataTable";

import { requireAdmin } from "../../guard";
import { saveApiKeyAction } from "../actions";
import { ApiKeyFields } from "../form";

export default async function NewApiKeyPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireAdmin(locale);
  const t = await getTranslations("asys.apikeys");
  const c = await getTranslations("asys.common");
  return (
    <div className="space-y-6">
      <PageHeader title={t("new")} actions={<BackLink href="/admin/apikeys" label={c("back")} />} />
      <SysForm action={saveApiKeyAction.bind(null, null)} submitLabel={c("create")} labels={{ ipaddr: t("ip") }}>
        <ApiKeyFields k={null} />
      </SysForm>
    </div>
  );
}
