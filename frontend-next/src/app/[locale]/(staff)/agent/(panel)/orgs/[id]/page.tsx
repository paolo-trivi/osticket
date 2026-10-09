import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import ComponentCard from "@/components/common/ComponentCard";
import DataTable, { PageHeader } from "@/components/common/DataTable";
import InfoRow from "@/components/common/InfoRow";
import { Link } from "@/i18n/navigation";
import { listUsers, loadOrg } from "@/server/domain/directory/directory";
import { GlobalPerm } from "@/server/domain/staff/staff";
import { agentTimeZone, formatDbDate } from "@/server/format/datetime";

import { requireAgent } from "../../../guard";

export default async function OrgPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const agent = await requireAgent(locale);
  const t = await getTranslations("directory");
  const org = await loadOrg(Number(id));
  if (!org) notFound();
  const tz = await agentTimeZone(agent);
  const users = await listUsers({ orgId: org.id, page: 1, pageSize: 200 });
  const canSeeUsers = agent.hasGlobalPerm(GlobalPerm.USER_DIR);

  return (
    <div className="space-y-6">
      <PageHeader
        title={org.name}
        subtitle={org.domain}
        actions={
          <Link href={`/agent/tickets?org=${org.id}`} className="rounded-lg bg-brand-500 px-4 py-2 text-sm text-white hover:bg-brand-600">
            {t("orgTickets")}
          </Link>
        }
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <ComponentCard title={t("profile")}>
          <dl>
            <InfoRow label={t("domain")} value={org.domain} />
            <InfoRow label={t("created")} value={formatDbDate(org.created, tz, locale)} />
            <InfoRow label={t("updated")} value={formatDbDate(org.updated, tz, locale)} />
            {org.fields.map((f) => (
              <InfoRow key={f.label} label={f.label} value={f.value} />
            ))}
          </dl>
        </ComponentCard>
        <div className="lg:col-span-2">
          <DataTable
            empty={t("empty")}
            columns={[
              { key: "name", label: t("name") },
              { key: "email", label: t("email") },
              { key: "tickets", label: t("tickets") },
            ]}
            rows={users.rows.map((u) => ({
              key: u.id,
              cells: {
                name: canSeeUsers ? <Link href={`/agent/users/${u.id}`} className="text-brand-600 dark:text-brand-400">{u.name}</Link> : u.name,
                email: u.email,
                tickets: u.tickets,
              },
            }))}
          />
        </div>
      </div>
    </div>
  );
}
