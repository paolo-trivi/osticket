import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";

import ComponentCard from "@/components/common/ComponentCard";
import DataTable, { PageHeader } from "@/components/common/DataTable";
import InfoRow from "@/components/common/InfoRow";
import AccountStatusBadge from "@/components/people/AccountStatusBadge";
import { RowSelect } from "@/components/people/directory/DirectoryButtons";
import OrgActions, { OrgMembersBar } from "@/components/people/directory/OrgActions";
import PersonTickets, { type TicketStateFilter } from "@/components/people/PersonTickets";
import { Link } from "@/i18n/navigation";
import { UserModel } from "@/lib/osticket/flags";
import { idOrNotFound } from "@/lib/route-id";
import { coreConfig } from "@/server/config/config";
import { db } from "@/server/db";
import { listUsers, loadOrg } from "@/server/domain/directory/directory";
import { editFormFields, newFormFields } from "@/server/domain/directory/ui";
import { activeTeams, assignableAgents } from "@/server/domain/task/model";
import { GlobalPerm } from "@/server/domain/staff/staff";
import { agentTimeZone, formatDbDate } from "@/server/format/datetime";

import { requireAgent } from "../../../guard";

export default async function OrgPage({
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
  const org = await loadOrg(idOrNotFound(id));
  if (!org) notFound();
  const tz = await agentTimeZone(agent);
  const users = await listUsers({ orgId: org.id, page: 1, pageSize: 200 });
  const canSeeUsers = agent.hasGlobalPerm(GlobalPerm.USER_DIR);
  const can = {
    edit: agent.hasGlobalPerm(GlobalPerm.ORG_EDIT),
    delete: agent.hasGlobalPerm(GlobalPerm.ORG_DELETE),
    addUser: agent.hasGlobalPerm(GlobalPerm.USER_EDIT),
    createUser: agent.hasGlobalPerm(GlobalPerm.USER_CREATE),
    import: agent.hasGlobalPerm(GlobalPerm.ORG_CREATE) && agent.hasGlobalPerm(GlobalPerm.USER_CREATE),
  };
  const cfg = await coreConfig();
  const [fields, userFields, agents, teams, members, allUsers] = await Promise.all([
    can.edit ? editFormFields("O", org.id, { name: org.name }) : Promise.resolve([]),
    can.createUser ? newFormFields("U") : Promise.resolve([]),
    can.edit ? assignableAgents(db(), null, agent, cfg) : Promise.resolve([]),
    can.edit ? activeTeams(db()) : Promise.resolve([]),
    db().selectFrom("user").select(["id", "name", "status"]).where("org_id", "=", org.id).orderBy("name").execute(),
    can.addUser ? db().selectFrom("user").select(["id", "name"]).where("org_id", "!=", org.id).orderBy("name").execute() : Promise.resolve([]),
  ]);

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
      <OrgActions
        data={{
          orgId: org.id,
          name: org.name,
          fields,
          userFields,
          profile: { domain: org.domain ?? "", manager: org.manager ?? "", status: org.status },
          managers: { agents, teams },
          members: members.map((m) => ({ id: m.id, name: m.name, primary: (m.status & UserModel.PRIMARY_ORG_CONTACT) !== 0 })),
          users: allUsers,
          can,
        }}
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
        <div className="space-y-3 lg:col-span-2">
          <OrgMembersBar orgId={org.id} canRemove={agent.hasGlobalPerm(GlobalPerm.USER_EDIT)} />
          <DataTable
            empty={t("empty")}
            columns={[
              { key: "sel", label: "" },
              { key: "name", label: t("name") },
              { key: "email", label: t("email") },
              { key: "status", label: t("status") },
              { key: "tickets", label: t("tickets") },
            ]}
            rows={users.rows.map((u) => ({
              key: u.id,
              cells: {
                sel: <RowSelect id={u.id} group="member" />,
                name: canSeeUsers ? <Link href={`/agent/users/${u.id}`} className="text-brand-600 dark:text-brand-400">{u.name}</Link> : u.name,
                email: u.email,
                status: <AccountStatusBadge status={u.account_status} />,
                tickets: u.tickets,
              },
            }))}
          />
        </div>
      </div>
      <PersonTickets
        agent={agent}
        criterion={["user__org_id", "equal", org.id]}
        filter={filter}
        basePath={`/agent/orgs/${org.id}`}
        allHref={`/agent/tickets?org=${org.id}`}
        tz={tz}
        locale={locale}
      />
    </div>
  );
}
