import { getTranslations, setRequestLocale } from "next-intl/server";

import AdminForm from "@/components/admin/AdminForm";
import { PageHeader } from "@/components/common/DataTable";
import { Link } from "@/i18n/navigation";

import { requireAdmin } from "../../guard";
import { saveAgentAction } from "../actions";
import { agentSections } from "../form";

export default async function NewAgentPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireAdmin(locale);
  const t = await getTranslations("admAgents");
  const sections = (await agentSections(null))!;
  return (
    <div className="space-y-6">
      <PageHeader
        title={t("new")}
        actions={
          <Link href="/admin/agents" className="text-sm font-medium text-brand-500 hover:text-brand-600">
            ← {t("back")}
          </Link>
        }
      />
      <AdminForm sections={sections} action={saveAgentAction.bind(null, null)} submitLabel={t("create")} />
    </div>
  );
}
