import { getTranslations, setRequestLocale } from "next-intl/server";

import BackLink from "@/components/adminsys/BackLink";
import AdminForm from "@/components/admin/AdminForm";
import { PageHeader } from "@/components/common/DataTable";

import { requireAdmin } from "../../guard";
import { saveTeamAction } from "../actions";
import { teamSections } from "../form";
import { adminMetadata } from "../../metadata";

export const generateMetadata = adminMetadata("teams");

export default async function NewPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireAdmin(locale);
  const t = await getTranslations("admTeams");
  const sections = (await teamSections(null))!;
  return (
    <div className="space-y-6">
      <PageHeader title={t("new")} actions={<BackLink href="/admin/teams" label={t("back")} />} />
      <AdminForm sections={sections} action={saveTeamAction.bind(null, null)} submitLabel={t("create")} />
    </div>
  );
}
