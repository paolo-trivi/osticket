import { getTranslations, setRequestLocale } from "next-intl/server";

import BackLink from "@/components/adminsys/BackLink";
import AdminForm from "@/components/admin/AdminForm";
import { PageHeader } from "@/components/common/DataTable";

import { requireAdmin } from "../../guard";
import { saveAgentAction } from "../actions";
import { agentSections } from "../form";
import { adminMetadata } from "../../metadata";

export const generateMetadata = adminMetadata("agentsList");

export default async function NewAgentPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireAdmin(locale);
  const t = await getTranslations("admAgents");
  const sections = (await agentSections(null))!;
  return (
    <div className="space-y-6">
      <PageHeader title={t("new")} actions={<BackLink href="/admin/agents" label={t("back")} />} />
      <AdminForm sections={sections} action={saveAgentAction.bind(null, null)} submitLabel={t("create")} />
    </div>
  );
}
