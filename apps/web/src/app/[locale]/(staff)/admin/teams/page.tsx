import { sql } from "kysely";
import { getTranslations, setRequestLocale } from "next-intl/server";

import AdminList from "@/components/admin/AdminList";
import Badge from "@/components/ui/badge/Badge";
import { Link } from "@/i18n/navigation";
import { Team } from "@/lib/osticket/flags";
import { db, table } from "@/server/db";

import { requireAdmin } from "../guard";
import { massTeamsAction } from "./actions";

/** Elenco team (include/staff/teams.inc.php). */
export default async function TeamsPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<Record<string, string>> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireAdmin(locale);
  const t = await getTranslations("admTeams");
  const u = await getTranslations("admUi");
  const sp = await searchParams;
  const { rows } = await sql<{ team_id: number; name: string; flags: number; members: number; lead: string | null }>`
    SELECT t.team_id, t.name, t.flags, (SELECT count(*) FROM ${table("team_member")} m WHERE m.team_id = t.team_id) AS members,
      (SELECT CONCAT_WS(' ', s.firstname, s.lastname) FROM ${table("staff")} s WHERE s.staff_id = t.lead_id) AS lead
    FROM ${table("team")} t ORDER BY t.name`.execute(db());
  return (
    <AdminList
      title={t("title")}
      subtitle={t("subtitle")}
      newHref="/admin/teams/new"
      newLabel={t("new")}
      action={massTeamsAction}
      notice={sp}
      empty={u("empty")}
      actions={[
        { value: "enable", label: u("enable") },
        { value: "disable", label: u("disable") },
        { value: "delete", label: u("delete"), danger: true },
      ]}
      columns={[
        { key: "name", label: t("name") },
        { key: "status", label: t("status") },
        { key: "members", label: t("members") },
        { key: "lead", label: t("lead") },
      ]}
      rows={rows.map((r) => ({
        id: r.team_id,
        label: r.name,
        cells: {
          name: (
            <Link href={`/admin/teams/${r.team_id}`} className="font-medium text-brand-500 hover:text-brand-600">
              {r.name}
            </Link>
          ),
          status: (
            <Badge size="sm" color={r.flags & Team.ENABLED ? "success" : "light"}>
              {r.flags & Team.ENABLED ? u("status.active") : u("status.disabled")}
            </Badge>
          ),
          members: Number(r.members),
          lead: r.lead ?? "—",
        },
      }))}
    />
  );
}
