import { getTranslations, setRequestLocale } from "next-intl/server";

import DataTable, { Forbidden, PageHeader, SearchBox } from "@/components/common/DataTable";
import LinkPager from "@/components/common/LinkPager";
import { ImportUsersButton, NewRecordButton, RowSelect, UserMassBar } from "@/components/people/directory/DirectoryButtons";
import { Link } from "@/i18n/navigation";
import { db } from "@/server/db";
import { listUsers } from "@/server/domain/directory/directory";
import { newFormFields } from "@/server/domain/directory/ui";
import { pageSizeFor } from "@/server/domain/queue/context";
import { GlobalPerm } from "@/server/domain/staff/staff";
import { agentTimeZone, formatDbDate } from "@/server/format/datetime";

import { requireAgent } from "../../guard";

export async function generateMetadata() {
  return { title: (await getTranslations("directory"))("users") };
}

export default async function UsersPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ q?: string; p?: string; sort?: string; dir?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const agent = await requireAgent(locale);
  const t = await getTranslations("directory");
  // scp/users.php: directory accessibile solo con user.dir
  if (!agent.hasGlobalPerm(GlobalPerm.USER_DIR)) return <Forbidden message={t("noAccess")} />;

  const sp = await searchParams;
  const page = Math.max(1, Number(sp.p) || 1);
  const pageSize = await pageSizeFor(agent);
  const desc = sp.dir === "1";
  const { rows, total } = await listUsers({ q: sp.q, sort: sp.sort, desc, page, pageSize });
  const tz = await agentTimeZone(agent);
  const canCreate = agent.hasGlobalPerm(GlobalPerm.USER_CREATE);
  const massCan = { manage: agent.hasGlobalPerm(GlobalPerm.USER_MANAGE), delete: agent.hasGlobalPerm(GlobalPerm.USER_DELETE), edit: agent.hasGlobalPerm(GlobalPerm.USER_EDIT) };
  const orgs = massCan.edit ? (await db().selectFrom("organization").select(["id", "name"]).orderBy("name").execute()) : [];
  const href = (extra: Record<string, string | number>) => {
    const p = new URLSearchParams();
    if (sp.q) p.set("q", sp.q);
    for (const [k, v] of Object.entries({ sort: sp.sort ?? "", dir: sp.dir ?? "", ...extra })) if (v !== "") p.set(k, String(v));
    return `/agent/users?${p}`;
  };
  const sortCol = (key: string) => ({
    sortHref: href({ sort: key, dir: sp.sort === key && !desc ? 1 : 0, p: 1 }),
    sorted: sp.sort === key || (!sp.sort && key === "name") ? ((desc ? "desc" : "asc") as "asc" | "desc") : undefined,
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("users")}
        subtitle={t("usersCount", { n: total })}
        actions={
          <div className="flex flex-wrap items-center gap-3">
            {canCreate && <NewRecordButton kind="user" fields={await newFormFields("U")} />}
            {canCreate && <ImportUsersButton />}
            <SearchBox action="/agent/users" value={sp.q} placeholder={t("searchUsers")} />
          </div>
        }
      />
      <UserMassBar can={massCan} orgs={massCan.edit ? orgs : []} />
      <DataTable
        empty={t("empty")}
        columns={[
          { key: "sel", label: "" },
          { key: "name", label: t("name"), ...sortCol("name") },
          { key: "email", label: t("email"), ...sortCol("email") },
          { key: "org", label: t("organization"), ...sortCol("org") },
          { key: "tickets", label: t("tickets") },
          { key: "updated", label: t("updated"), ...sortCol("updated") },
        ]}
        rows={rows.map((u) => ({
          key: u.id,
          cells: {
            sel: <RowSelect id={u.id} group="user" />,
            name: (
              <Link href={`/agent/users/${u.id}`} className="font-medium text-brand-600 hover:underline dark:text-brand-400">
                {u.name}
              </Link>
            ),
            email: u.email,
            org: u.org_id ? <Link href={`/agent/orgs/${u.org_id}`}>{u.org_name}</Link> : "—",
            tickets: u.tickets ? <Link href={`/agent/tickets?user=${u.id}`}>{u.tickets}</Link> : 0,
            updated: formatDbDate(u.updated, tz, locale, "date"),
          },
        }))}
      />
      <LinkPager page={page} totalPages={Math.max(1, Math.ceil(total / pageSize))} href={(p) => href({ p })} labels={{ prev: t("prev"), next: t("next") }} />
    </div>
  );
}
