import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import AdminForm from "@/components/admin/AdminForm";
import AdminNotice from "@/components/admin/AdminNotice";
import { PageHeader } from "@/components/common/DataTable";
import { Link } from "@/i18n/navigation";

import { requireAdmin } from "../../guard";
import { saveDeptAction } from "../actions";
import { deptSections } from "../form";

export default async function EditPage({ params, searchParams }: { params: Promise<{ locale: string; id: string }>; searchParams: Promise<Record<string, string>> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  await requireAdmin(locale);
  const t = await getTranslations("admDepts");
  const objectId = Number(id);
  const sections = Number.isInteger(objectId) && objectId > 0 ? await deptSections(objectId) : null;
  if (!sections) notFound();
  const sp = await searchParams;
  return (
    <div className="space-y-6">
      <PageHeader
        title={t("edit")}
        actions={
          <Link href="/admin/departments" className="text-sm font-medium text-brand-500 hover:text-brand-600">
            ← {t("back")}
          </Link>
        }
      />
      {sp.created && <AdminNotice ok="created" n="1" />}
      <AdminForm sections={sections} action={saveDeptAction.bind(null, objectId)} />
    </div>
  );
}
