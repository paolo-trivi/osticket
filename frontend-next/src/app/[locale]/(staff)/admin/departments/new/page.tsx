import { getTranslations, setRequestLocale } from "next-intl/server";

import AdminForm from "@/components/admin/AdminForm";
import { PageHeader } from "@/components/common/DataTable";
import { Link } from "@/i18n/navigation";

import { requireAdmin } from "../../guard";
import { saveDeptAction } from "../actions";
import { deptSections } from "../form";

export default async function NewPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireAdmin(locale);
  const t = await getTranslations("admDepts");
  const sections = (await deptSections(null))!;
  return (
    <div className="space-y-6">
      <PageHeader
        title={t("new")}
        actions={
          <Link href="/admin/departments" className="text-sm font-medium text-brand-500 hover:text-brand-600">
            ← {t("back")}
          </Link>
        }
      />
      <AdminForm sections={sections} action={saveDeptAction.bind(null, null)} submitLabel={t("create")} />
    </div>
  );
}
