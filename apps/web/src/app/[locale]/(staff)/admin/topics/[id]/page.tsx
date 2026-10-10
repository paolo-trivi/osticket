import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import AdminForm from "@/components/admin/AdminForm";
import AdminNotice from "@/components/admin/AdminNotice";
import { PageHeader } from "@/components/common/DataTable";
import { Link } from "@/i18n/navigation";
import { idOrNotFound } from "@/lib/route-id";

import { requireAdmin } from "../../guard";
import { saveTopicAction } from "../actions";
import { topicSections } from "../form";

export default async function EditPage({ params, searchParams }: { params: Promise<{ locale: string; id: string }>; searchParams: Promise<Record<string, string>> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  await requireAdmin(locale);
  const t = await getTranslations("admTopics");
  const objectId = idOrNotFound(id);
  const sections = await topicSections(objectId);
  if (!sections) notFound();
  const sp = await searchParams;
  return (
    <div className="space-y-6">
      <PageHeader
        title={t("edit")}
        actions={
          <Link href="/admin/topics" className="text-sm font-medium text-brand-500 hover:text-brand-600">
            ← {t("back")}
          </Link>
        }
      />
      {sp.created && <AdminNotice ok="created" n="1" />}
      <AdminForm sections={sections} action={saveTopicAction.bind(null, objectId)} />
    </div>
  );
}
