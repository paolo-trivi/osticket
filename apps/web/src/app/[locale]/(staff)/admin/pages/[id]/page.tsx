import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import BackLink from "@/components/adminsys/BackLink";
import SysForm from "@/components/adminsys/SysForm";
import SysNotice from "@/components/adminsys/SysNotice";
import { PageHeader } from "@/components/common/DataTable";
import { idOrNotFound } from "@/lib/route-id";
import { db } from "@/server/db";

import { requireAdmin } from "../../guard";
import { savePageAction } from "../actions";
import { PageFields } from "../form";
import { adminMetadata } from "../../metadata";

export const generateMetadata = adminMetadata("pages");

export default async function EditSitePage({ params, searchParams }: { params: Promise<{ locale: string; id: string }>; searchParams: Promise<Record<string, string>> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  await requireAdmin(locale);
  const pageId = idOrNotFound(id);
  const page = await db().selectFrom("content").selectAll().where("id", "=", pageId).executeTakeFirst();
  if (!page) notFound();
  const t = await getTranslations("asys.pages");
  const c = await getTranslations("asys.common");
  const sp = await searchParams;
  return (
    <div className="space-y-6">
      <PageHeader title={page.name} subtitle={t("edit")} actions={<BackLink href="/admin/pages" label={c("back")} />} />
      <SysNotice sp={sp} />
      <SysForm action={savePageAction.bind(null, pageId)} labels={{ name: t("name"), type: t("type"), body: t("body"), isactive: t("status") }}>
        <PageFields page={page} />
      </SysForm>
    </div>
  );
}
