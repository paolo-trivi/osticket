import "server-only";

import { getTranslations } from "next-intl/server";

import type { FormSection } from "@/lib/admin/form-schema";
import { db } from "@/server/db";
import { staffOptions } from "@/server/domain/admin/lookups";
import { TeamFlag } from "@/server/domain/admin/team";

/** Sezioni del form team (include/staff/team.inc.php). */
export async function teamSections(teamId: number | null): Promise<FormSection[] | null> {
  const t = await getTranslations("admTeams");
  const u = await getTranslations("admUi");
  const team = teamId ? await db().selectFrom("team").selectAll().where("team_id", "=", teamId).executeTakeFirst() : null;
  if (teamId && !team) return null;
  const flags = team?.flags ?? TeamFlag.ENABLED;
  const staff = await staffOptions();
  const members = teamId ? await db().selectFrom("team_member").select(["staff_id", "flags"]).where("team_id", "=", teamId).execute() : [];
  return [
    {
      title: t("sections.team"),
      fields: [
        { kind: "hidden", name: "do", value: teamId ? "update" : "create" },
        { kind: "hidden", name: "id", value: teamId ? String(teamId) : "" },
        { kind: "text", name: "name", label: t("name"), value: team?.name ?? "", required: true },
        {
          kind: "radio",
          name: "isenabled",
          label: t("status"),
          value: flags & TeamFlag.ENABLED ? "1" : "0",
          options: [
            { value: "1", label: u("status.active") },
            { value: "0", label: u("status.disabled") },
          ],
        },
        { kind: "select", name: "lead_id", label: t("lead"), value: String(team?.lead_id ?? 0), options: [{ value: "0", label: u("none") }, ...staff] },
        { kind: "checkbox", name: "noalerts", label: t("noAlerts"), checked: !!(flags & TeamFlag.NOALERTS) },
        { kind: "textarea", name: "notes", label: t("notes"), value: team?.notes ?? "", rows: 3, wide: true },
      ],
    },
    {
      title: t("sections.members"),
      fields: [
        {
          kind: "access",
          name: "members",
          label: t("members"),
          ids: "members",
          alerts: "member_alerts",
          choices: staff,
          wide: true,
          selected: members.map((m) => ({ id: String(m.staff_id), alerts: !!(m.flags & 1) })),
        },
      ],
    },
  ];
}
