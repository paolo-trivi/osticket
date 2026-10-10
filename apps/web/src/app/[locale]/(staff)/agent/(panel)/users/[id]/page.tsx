import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import ComponentCard from "@/components/common/ComponentCard";
import { Forbidden, PageHeader } from "@/components/common/DataTable";
import AccountStatusBadge from "@/components/people/AccountStatusBadge";
import UserActions from "@/components/people/directory/UserActions";
import PersonTickets, { type TicketStateFilter } from "@/components/people/PersonTickets";
import { Link } from "@/i18n/navigation";
import { idOrNotFound } from "@/lib/route-id";
import { db } from "@/server/db";
import { loadUser } from "@/server/domain/directory/directory";
import { editFormFields } from "@/server/domain/directory/ui";
import { GlobalPerm } from "@/server/domain/staff/staff";
import { agentTimeZone, formatDbDate } from "@/server/format/datetime";

import { requireAgent } from "../../../guard";

export default async function UserPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<{ tickets?: string }>;
}) {
  const { locale, id } = await params;
  const { tickets } = await searchParams;
  const filter: TicketStateFilter = tickets === "open" || tickets === "closed" ? tickets : "all";
  setRequestLocale(locale);
  const agent = await requireAgent(locale);
  const t = await getTranslations("directory");
  if (!agent.hasGlobalPerm(GlobalPerm.USER_DIR)) return <Forbidden message={t("noAccess")} />;
  const user = await loadUser(idOrNotFound(id));
  if (!user) notFound();
  const tz = await agentTimeZone(agent);
  // UserAccount: status con i bit di UserAccountStatus (confermato, bloccato…)
  const [fields, acct, orgs] = await Promise.all([
    editFormFields("U", user.id, { name: user.name, email: user.email ?? "" }),
    db().selectFrom("user_account").select(["status", "username", "timezone"]).where("user_id", "=", user.id).executeTakeFirst(),
    db().selectFrom("organization").select(["id", "name"]).orderBy("name").execute(),
  ]);

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
      <UserActions
        data={{
          userId: user.id,
          name: user.name,
          orgId: user.org_id,
          orgName: user.org_name,
          tickets: user.tickets,
          fields,
          account: acct ? { status: acct.status, username: acct.username ?? "", timezone: acct.timezone ?? "" } : null,
          orgs,
          timezones: Intl.supportedValuesOf("timeZone"),
          can: {
            edit: agent.hasGlobalPerm(GlobalPerm.USER_EDIT),
            delete: agent.hasGlobalPerm(GlobalPerm.USER_DELETE),
            manage: agent.hasGlobalPerm(GlobalPerm.USER_MANAGE),
            createOrg: agent.hasGlobalPerm(GlobalPerm.ORG_CREATE),
          },
        }}
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ComponentCard title={t("profile")}>
          <dl className="space-y-2 text-sm">
            <Row label={t("emails")} value={user.emails.join(", ")} />
            <Row label={t("organization")} value={user.org_id ? <Link href={`/agent/orgs/${user.org_id}`}>{user.org_name}</Link> : "—"} />
            <Row label={t("account")} value={<AccountStatusBadge status={user.account_status} />} />
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
      <PersonTickets
        agent={agent}
        criterion={["user_id", "equal", user.id]}
        filter={filter}
        basePath={`/agent/users/${user.id}`}
        allHref={`/agent/tickets?user=${user.id}`}
        tz={tz}
        locale={locale}
      />
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
