import { getFormatter, getTranslations, setRequestLocale } from "next-intl/server";

import ComponentCard from "@/components/common/ComponentCard";
import Badge from "@/components/ui/badge/Badge";
import { coreConfig } from "@/server/config/config";
import { db } from "@/server/db";
import { fromDb } from "@/server/db/time";
import { GlobalPerm } from "@/server/domain/staff/staff";

import { requireAgent } from "../guard";

export default async function AgentDashboardPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const agent = await requireAgent(locale);
  const t = await getTranslations("dashboard");
  const format = await getFormatter();

  const [depts, teams] = await Promise.all([
    agent.deptIds.length
      ? db().selectFrom("department").select(["id", "name"]).where("id", "in", [...agent.deptIds]).orderBy("name").execute()
      : Promise.resolve([]),
    agent.teamIds.length
      ? db().selectFrom("team").select(["team_id", "name"]).where("team_id", "in", [...agent.teamIds]).execute()
      : Promise.resolve([]),
  ]);
  const primary = depts.find((d) => d.id === agent.deptId);
  const lastLogin = fromDb(agent.row.lastlogin);
  // Fuso dell'agente, altrimenti quello di sistema (OsticketConfig::getTimezone)
  const timeZone = agent.row.timezone || (await coreConfig()).str("default_timezone") || "UTC";
  const globalPerms = Object.values(GlobalPerm).filter((p) => agent.hasGlobalPerm(p));

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold text-gray-800 dark:text-white/90">{t("welcome", { name: agent.name.full })}</h2>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <ComponentCard title={t("primaryDept")}>
          <p className="text-gray-800 dark:text-white/90">{primary?.name ?? "—"}</p>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t("role")}: {agent.primaryRole.name}
          </p>
          {lastLogin && (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {t("lastLogin")}: {format.dateTime(lastLogin.toJSDate(), { dateStyle: "medium", timeStyle: "short", timeZone })}
            </p>
          )}
          {agent.isAccessLimited && <Badge color="warning">{t("limitedAccess")}</Badge>}
        </ComponentCard>
        <ComponentCard title={t("departments")}>
          <div className="flex flex-wrap gap-2">
            {depts.map((d) => (
              <Badge key={d.id} color={d.id === agent.deptId ? "primary" : "light"}>
                {d.name}
              </Badge>
            ))}
          </div>
          {teams.length > 0 && (
            <>
              <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{t("teams")}</p>
              <div className="flex flex-wrap gap-2">
                {teams.map((tm) => (
                  <Badge key={tm.team_id} color="info">
                    {tm.name}
                  </Badge>
                ))}
              </div>
            </>
          )}
        </ComponentCard>
        <ComponentCard title={t("rolePerms")}>
          <div className="flex flex-wrap gap-2">
            {agent.primaryRole.perms.keys().map((p) => (
              <Badge key={p} color="success" size="sm">
                {p}
              </Badge>
            ))}
          </div>
        </ComponentCard>
        <ComponentCard title={t("globalPerms")}>
          <div className="flex flex-wrap gap-2">
            {globalPerms.map((p) => (
              <Badge key={p} color="info" size="sm">
                {p}
              </Badge>
            ))}
          </div>
        </ComponentCard>
      </div>
    </div>
  );
}
