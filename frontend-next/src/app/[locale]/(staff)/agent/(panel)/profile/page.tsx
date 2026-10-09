import { getTranslations, setRequestLocale } from "next-intl/server";

import ComponentCard from "@/components/common/ComponentCard";
import { PageHeader } from "@/components/common/DataTable";
import InfoRow from "@/components/common/InfoRow";
import Badge from "@/components/ui/badge/Badge";
import { db } from "@/server/db";
import { GlobalPerm } from "@/server/domain/staff/staff";
import { agentTimeZone, formatDbDate } from "@/server/format/datetime";

import { requireAgent } from "../../guard";

export async function generateMetadata() {
  return { title: (await getTranslations("profile"))("title") };
}

export default async function ProfilePage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ pwchange?: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const agent = await requireAgent(locale);
  const t = await getTranslations("profile");
  const sp = await searchParams;
  const tz = await agentTimeZone(agent);
  const dept = await db().selectFrom("department").select("name").where("id", "=", agent.deptId).executeTakeFirst();
  const globalPerms = Object.values(GlobalPerm).filter((p) => agent.hasGlobalPerm(p));
  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} subtitle={agent.email} />
      {(sp.pwchange || agent.mustChangePassword) && (
        <div className="rounded-xl border border-warning-300 bg-warning-50 p-4 text-sm text-warning-700 dark:border-warning-500/30 dark:bg-warning-500/10 dark:text-warning-400">
          {t("mustChangePassword")}
        </div>
      )}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ComponentCard title={t("account")}>
          <dl>
            <InfoRow label={t("name")} value={agent.name.full} />
            <InfoRow label={t("username")} value={agent.username} />
            <InfoRow label={t("email")} value={agent.email} />
            <InfoRow label={t("phone")} value={agent.row.phone} />
            <InfoRow label={t("mobile")} value={agent.row.mobile} />
            <InfoRow label={t("department")} value={dept?.name} />
            <InfoRow label={t("role")} value={agent.primaryRole.name} />
            <InfoRow label={t("lastLogin")} value={formatDbDate(agent.row.lastlogin, tz, locale)} />
          </dl>
        </ComponentCard>
        <ComponentCard title={t("preferences")}>
          <dl>
            <InfoRow label={t("timezone")} value={agent.row.timezone || t("systemDefault")} />
            <InfoRow label={t("language")} value={agent.row.lang || t("systemDefault")} />
            <InfoRow label={t("pageSize")} value={agent.row.max_page_size || t("systemDefault")} />
            <InfoRow label={t("signatureType")} value={agent.row.default_signature_type} />
            <InfoRow label={t("threadOrder")} value={agent.config.str("thread_view_order") || t("systemDefault")} />
          </dl>
        </ComponentCard>
        <ComponentCard title={t("permissions")}>
          <div className="flex flex-wrap gap-2">
            {globalPerms.map((p) => (
              <Badge key={p} size="sm" color="info">{p}</Badge>
            ))}
            {agent.primaryRole.perms.keys().map((p) => (
              <Badge key={p} size="sm" color="success">{p}</Badge>
            ))}
          </div>
        </ComponentCard>
      </div>
    </div>
  );
}
