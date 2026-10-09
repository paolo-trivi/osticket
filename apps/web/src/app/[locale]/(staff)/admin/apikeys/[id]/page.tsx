import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";

import BackLink from "@/components/adminsys/BackLink";
import SysForm from "@/components/adminsys/SysForm";
import SysNotice from "@/components/adminsys/SysNotice";
import { PageHeader } from "@/components/common/DataTable";
import { db } from "@/server/db";

import { requireAdmin } from "../../guard";
import { saveApiKeyAction } from "../actions";
import { ApiKeyFields } from "../form";

export default async function EditApiKeyPage({ params, searchParams }: { params: Promise<{ locale: string; id: string }>; searchParams: Promise<Record<string, string>> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  await requireAdmin(locale);
  const keyId = Number(id);
  const k = Number.isInteger(keyId) && keyId > 0 ? await db().selectFrom("api_key").selectAll().where("id", "=", keyId).executeTakeFirst() : null;
  if (!k) notFound();
  const t = await getTranslations("asys.apikeys");
  const c = await getTranslations("asys.common");
  const sp = await searchParams;
  return (
    <div className="space-y-6">
      <PageHeader title={k.ipaddr} subtitle={t("edit")} actions={<BackLink href="/admin/apikeys" label={c("back")} />} />
      <SysNotice sp={sp} />
      <SysForm action={saveApiKeyAction.bind(null, keyId)}>
        <ApiKeyFields k={k} />
      </SysForm>
    </div>
  );
}
