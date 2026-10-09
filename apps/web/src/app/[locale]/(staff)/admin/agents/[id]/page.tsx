import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import AdminForm from "@/components/admin/AdminForm";
import AdminNotice from "@/components/admin/AdminNotice";
import { PageHeader } from "@/components/common/DataTable";
import { Link } from "@/i18n/navigation";

import { requireAdmin } from "../../guard";
import { agentPasswordAction, saveAgentAction } from "../actions";
import { agentSections, passwordSections } from "../form";

export default async function EditAgentPage({ params, searchParams }: { params: Promise<{ locale: string; id: string }>; searchParams: Promise<Record<string, string>> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  await requireAdmin(locale);
  const t = await getTranslations("admAgents");
  const staffId = Number(id);
  const sections = Number.isInteger(staffId) && staffId > 0 ? await agentSections(staffId) : null;
  if (!sections) notFound();
  const sp = await searchParams;
  return (
    <div className="space-y-6">
      <PageHeader
        title={t("edit")}
        actions={
          <Link href="/admin/agents" className="text-sm font-medium text-brand-500 hover:text-brand-600">
            ← {t("back")}
          </Link>
        }
      />
      {sp.created && <AdminNotice ok="created" n="1" />}
      <AdminForm sections={sections} action={saveAgentAction.bind(null, staffId)} />
      <AdminForm sections={await passwordSections()} action={agentPasswordAction.bind(null, staffId)} submitLabel={t("applyPassword")} savedMessage={t("passwordDone")} />
    </div>
  );
}
