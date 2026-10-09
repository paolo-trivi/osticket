import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import ComponentCard from "@/components/common/ComponentCard";
import { Forbidden, PageHeader } from "@/components/common/DataTable";
import { Link } from "@/i18n/navigation";
import { loadUser } from "@/server/domain/directory/directory";
import { GlobalPerm } from "@/server/domain/staff/staff";
import { agentTimeZone, formatDbDate } from "@/server/format/datetime";

import { requireAgent } from "../../../guard";

export default async function UserPage({ params }: { params: Promise<{ locale: string; id: string }> }) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const agent = await requireAgent(locale);
  const t = await getTranslations("directory");
  if (!agent.hasGlobalPerm(GlobalPerm.USER_DIR)) return <Forbidden message={t("noAccess")} />;
  const user = await loadUser(Number(id));
  if (!user) notFound();
  const tz = await agentTimeZone(agent);
  // UserAccount: status & 1 = confermato, & 2 = bloccato
  const account = user.account_status === null ? t("noAccount") : user.account_status & 2 ? t("accountLocked") : user.account_status & 1 ? t("accountActive") : t("accountPending");

  return (
    <div className="space-y-6">
      <PageHeader
        title={user.name}
        subtitle={user.email}
        actions={
          <Link href={`/agent/tickets?user=${user.id}`} className="rounded-lg bg-brand-500 px-4 py-2 text-sm text-white hover:bg-brand-600">
            {t("viewTickets", { n: user.tickets })}
          </Link>
        }
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ComponentCard title={t("profile")}>
          <dl className="space-y-2 text-sm">
            <Row label={t("emails")} value={user.emails.join(", ")} />
            <Row label={t("organization")} value={user.org_id ? <Link href={`/agent/orgs/${user.org_id}`}>{user.org_name}</Link> : "—"} />
            <Row label={t("account")} value={account} />
            {user.username && <Row label={t("username")} value={user.username} />}
            <Row label={t("created")} value={formatDbDate(user.created, tz, locale)} />
            <Row label={t("updated")} value={formatDbDate(user.updated, tz, locale)} />
          </dl>
        </ComponentCard>
        <ComponentCard title={t("fields")}>
          <dl className="space-y-2 text-sm">
            {user.fields.length ? user.fields.map((f) => <Row key={f.label} label={f.label} value={f.value} />) : <p className="text-gray-500">—</p>}
          </dl>
        </ComponentCard>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="text-end text-gray-800 dark:text-white/90">{value || "—"}</dd>
    </div>
  );
}
