import { getTranslations, setRequestLocale } from "next-intl/server";

import BackLink from "@/components/adminsys/BackLink";
import AdminForm from "@/components/admin/AdminForm";
import { PageHeader } from "@/components/common/DataTable";

import { requireAdmin } from "../../guard";
import { saveRoleAction } from "../actions";
import { roleSections } from "../form";
import { adminMetadata } from "../../metadata";

export const generateMetadata = adminMetadata("roles");

export default async function NewPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireAdmin(locale);
  const t = await getTranslations("admRoles");
  const sections = (await roleSections(null))!;
  return (
    <div className="space-y-6">
      <PageHeader title={t("new")} actions={<BackLink href="/admin/roles" label={t("back")} />} />
      <AdminForm sections={sections} action={saveRoleAction.bind(null, null)} submitLabel={t("create")} />
    </div>
  );
}
