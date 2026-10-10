import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import BackLink from "@/components/adminsys/BackLink";
import AdminForm from "@/components/admin/AdminForm";
import AdminNotice from "@/components/admin/AdminNotice";
import { PageHeader } from "@/components/common/DataTable";
import { idOrNotFound } from "@/lib/route-id";

import { requireAdmin } from "../../guard";
import { agentPasswordAction, saveAgentAction } from "../actions";
import { agentSections, passwordSections } from "../form";
import { adminMetadata } from "../../metadata";

export const generateMetadata = adminMetadata("agentsList");

export default async function EditAgentPage({ params, searchParams }: { params: Promise<{ locale: string; id: string }>; searchParams: Promise<Record<string, string>> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  await requireAdmin(locale);
  const t = await getTranslations("admAgents");
  const staffId = idOrNotFound(id);
  const sections = await agentSections(staffId);
  if (!sections) notFound();
  const sp = await searchParams;
  return (
    <div className="space-y-6">
      <PageHeader title={t("edit")} actions={<BackLink href="/admin/agents" label={t("back")} />} />
      {sp.created && <AdminNotice ok="created" n="1" />}
      <AdminForm sections={sections} action={saveAgentAction.bind(null, staffId)} />
      <AdminForm sections={await passwordSections()} action={agentPasswordAction.bind(null, staffId)} submitLabel={t("applyPassword")} savedMessage={t("passwordDone")} />
    </div>
  );
}
