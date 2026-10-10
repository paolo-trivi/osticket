import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import BackLink from "@/components/adminsys/BackLink";
import AdminForm from "@/components/admin/AdminForm";
import AdminNotice from "@/components/admin/AdminNotice";
import { PageHeader } from "@/components/common/DataTable";
import { idOrNotFound } from "@/lib/route-id";

import { requireAdmin } from "../../guard";
import { saveSlaAction } from "../actions";
import { slaSections } from "../form";
import { adminMetadata } from "../../metadata";

export const generateMetadata = adminMetadata("sla");

export default async function EditPage({ params, searchParams }: { params: Promise<{ locale: string; id: string }>; searchParams: Promise<Record<string, string>> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  await requireAdmin(locale);
  const t = await getTranslations("admSla");
  const objectId = idOrNotFound(id);
  const sections = await slaSections(objectId);
  if (!sections) notFound();
  const sp = await searchParams;
  return (
    <div className="space-y-6">
      <PageHeader title={t("edit")} actions={<BackLink href="/admin/sla" label={t("back")} />} />
      {sp.created && <AdminNotice ok="created" n="1" cs={sp.cs} />}
      <AdminForm sections={sections} action={saveSlaAction.bind(null, objectId)} />
    </div>
  );
}
