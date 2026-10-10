import { getTranslations, setRequestLocale } from "next-intl/server";

import { NewButton } from "@/components/adminsys/BackLink";
import SysNotice from "@/components/adminsys/SysNotice";
import MassBar from "@/components/admin/MassBar";
import DataTable, { PageHeader } from "@/components/common/DataTable";
import Badge from "@/components/ui/badge/Badge";
import { Link } from "@/i18n/navigation";
import { db } from "@/server/db";
import { listApiKeys } from "@/server/domain/adminsys/apikey";

import { dateFormatter } from "../_sys/server";
import { requireAdmin } from "../guard";
import { massApiKeyAction } from "./actions";
import { adminMetadata } from "../metadata";

export const generateMetadata = adminMetadata("apikeys");

/** Chiavi API (include/staff/apikeys.inc.php). */
export default async function ApiKeysPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string>> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const agent = await requireAdmin(locale);
  const t = await getTranslations("asys.apikeys");
  const c = await getTranslations("asys.common");
  const sp = await searchParams;
  const date = await dateFormatter(agent, locale);
  const keys = await listApiKeys(db());
  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} subtitle={t("subtitle")} actions={<NewButton href="/admin/apikeys/new" label={t("new")} />} />
      <SysNotice sp={sp} />
      <form action={massApiKeyAction} className="space-y-4">
        <MassBar
          actions={[
            { value: "enable", label: c("enable") },
            { value: "disable", label: c("disable") },
            { value: "delete", label: c("delete"), danger: true },
          ]}
        />
        <DataTable
          empty={c("empty")}
          columns={[
            { key: "sel", label: "", className: "w-10" },
            { key: "key", label: t("key") },
            { key: "ip", label: t("ip") },
            { key: "status", label: t("status") },
            { key: "created", label: c("created") },
            { key: "updated", label: c("updated") },
          ]}
          rows={keys.map((k) => ({
            key: k.id,
            cells: {
              sel: <input type="checkbox" name="ids[]" value={k.id} className="h-4 w-4 accent-brand-500" aria-label={k.apikey} />,
              key: (
                <Link href={`/admin/apikeys/${k.id}`} className="font-mono text-theme-xs font-medium text-brand-500 hover:text-brand-600">
                  {k.apikey}
                </Link>
              ),
              ip: k.ipaddr,
              status: (
                <Badge size="sm" color={k.isactive ? "success" : "light"}>
                  {k.isactive ? c("active") : c("disabled")}
                </Badge>
              ),
              created: date(k.created, "date"),
              updated: date(k.updated),
            },
          }))}
        />
      </form>
    </div>
  );
}
