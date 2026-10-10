import { getTranslations, setRequestLocale } from "next-intl/server";

import BackLink from "@/components/adminsys/BackLink";
import AdminForm from "@/components/admin/AdminForm";
import { PageHeader } from "@/components/common/DataTable";

import { requireAdmin } from "../../guard";
import { saveSlaAction } from "../actions";
import { slaSections } from "../form";
import { adminMetadata } from "../../metadata";

export const generateMetadata = adminMetadata("sla");

export default async function NewPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireAdmin(locale);
  const t = await getTranslations("admSla");
  const sections = (await slaSections(null))!;
  return (
    <div className="space-y-6">
      <PageHeader title={t("new")} actions={<BackLink href="/admin/sla" label={t("back")} />} />
      <AdminForm sections={sections} action={saveSlaAction.bind(null, null)} submitLabel={t("create")} />
    </div>
  );
}
