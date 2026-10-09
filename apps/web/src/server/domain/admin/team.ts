import "server-only";

import { sql } from "kysely";

import type { DbOrTx } from "../../db";
import { stripTags } from "../../format/html";
import { sanitizeText } from "../../format/text";
import { at, inArray, isset, list, phpLooseEquals, str, truthy, type PhpVal, type PhpVars } from "../../php/values";
import { exists, idOf, type MassResult, type SaveResult } from "./common";
import { FILTER_REFS, filterActionsReferencing } from "./filters";
import { OrmRow, SQL_NOW, setFlag } from "./orm";

/** Team: scp/teams.php → Team::update / Team::delete / mass_process (include/class.team.php). */
export const TeamFlag = { ENABLED: 0x0001, NOALERTS: 0x0002 } as const;
/** TeamMember::FLAG_ALERTS */
export const MEMBER_ALERTS = 0x0001;

const TEAM_OPTS = { touchUpdated: true };

/** Team::update($vars, $errors) — creazione se teamId è null (Team::create()). */
export async function saveTeam(executor: DbOrTx, teamId: number | null, vars: PhpVars): Promise<SaveResult> {
  const errors: Record<string, string> = {};
  let team: OrmRow;
  if (teamId) {
    const row = await OrmRow.load(executor, "team", "team_id", { team_id: teamId }, TEAM_OPTS);
    if (!row) return { ok: false, errors: { err: "not_found" } };
    team = row;
  } else {
    team = OrmRow.create("team", "team_id", TEAM_OPTS);
    team.set("created", SQL_NOW);
  }
  if (!truthy(vars.name)) errors.name = "required";
  else {
    // Team::getIdByName: nome con trim
    const row = await executor.selectFrom("team").select("team_id").where("name", "=", str(vars.name).trim()).executeTakeFirst();
    if (row?.team_id && !phpLooseEquals(row.team_id, vars.id as never)) errors.name = "exists";
  }
  const noalerts = isset(vars, "noalerts") ? TeamFlag.NOALERTS : 0;
  // Il capo team rimosso dai membri viene azzerato
  let leadId: PhpVal = vars.lead_id;
  const curLead = team.get("lead_id");
  if (curLead !== null && phpLooseEquals(curLead, leadId as never) && truthy(vars.remove) && inArray(curLead as PhpVal, vars.remove)) leadId = 0;

  team.set("flags", (truthy(vars.isenabled) ? TeamFlag.ENABLED : 0) | noalerts);
  team.set("lead_id", truthy(leadId) ? str(leadId) : 0);
  team.set("name", stripTags(str(vars.name)));
  team.set("notes", sanitizeText(str(vars.notes)));
  const access: [PhpVal, PhpVal][] = [];
  if (isset(vars, "members")) for (const sid of list(vars.members)) access.push([sid, at(vars.member_alerts, str(sid))]);
  if (Object.keys(errors).length) return { ok: false, errors };
  await team.save(executor);
  const id = team.num("team_id");
  await updateMembers(executor, id, access, errors);
  return { ok: true, id, errors: {} };
}

/** Team::updateMembers: nuovi membri e avvisi, poi rimozione dei membri non più elencati. */
async function updateMembers(executor: DbOrTx, teamId: number, access: [PhpVal, PhpVal][], errors: Record<string, string>): Promise<boolean> {
  const members = (await executor.selectFrom("team_member").selectAll().where("team_id", "=", teamId).execute()).map((r) => OrmRow.from("team_member", ["team_id", "staff_id"], r));
  const dropped = new Set(members.map((m) => m.num("staff_id")));
  const memberErrors: Record<string, string> = {};
  for (const [staffId, alerts] of access) {
    dropped.delete(idOf(staffId) ?? -1);
    if (!truthy(staffId) || !(await exists(executor, "staff", staffId))) memberErrors[str(staffId)] = "agent";
    let m = members.find((r) => phpLooseEquals(r.get("staff_id"), staffId as never));
    if (!m) {
      m = OrmRow.create("team_member", ["team_id", "staff_id"]);
      m.set("staff_id", str(staffId));
      m.set("team_id", teamId);
      members.push(m);
    }
    setFlag(m, MEMBER_ALERTS, truthy(alerts));
  }
  if (Object.keys(memberErrors).length) {
    errors.members = JSON.stringify(memberErrors);
    return false;
  }
  for (const m of members) await m.save(executor);
  if (dropped.size) await executor.deleteFrom("team_member").where("team_id", "=", teamId).where("staff_id", "in", [...dropped]).execute();
  return true;
}

/** Team::delete(): membri eliminati, ticket del team senza team. */
async function deleteTeam(executor: DbOrTx, teamId: number): Promise<{ ok: boolean; error?: string }> {
  if (await filterActionsReferencing(executor, FILTER_REFS.team, teamId)) return { ok: false, error: "filter" };
  const res = await executor.deleteFrom("team").where("team_id", "=", teamId).executeTakeFirst();
  if (!Number(res.numDeletedRows)) return { ok: false };
  await executor.deleteFrom("team_member").where("team_id", "=", teamId).execute();
  await executor.updateTable("ticket").set({ team_id: 0 }).where("team_id", "=", teamId).execute();
  return { ok: true };
}

export type TeamMassAction = "enable" | "disable" | "delete";

export async function massTeams(executor: DbOrTx, action: TeamMassAction, ids: number[]): Promise<MassResult> {
  if (!ids.length) return { ok: false, num: 0, error: "select" };
  switch (action) {
    case "enable":
    case "disable": {
      const expr = action === "enable" ? sql<number>`flags | ${TeamFlag.ENABLED}` : sql<number>`flags & ${~TeamFlag.ENABLED >>> 0}`;
      const res = await executor.updateTable("team").set({ flags: expr }).where("team_id", "in", ids).executeTakeFirst();
      const num = Number(res.numUpdatedRows);
      return { ok: num > 0, num };
    }
    case "delete": {
      let num = 0;
      for (const id of ids) {
        if (!(await executor.selectFrom("team").select("team_id").where("team_id", "=", id).executeTakeFirst())) continue;
        const r = await deleteTeam(executor, id);
        if (r.error === "filter") return { ok: num > 0, num, error: "filter" };
        num++;
      }
      return { ok: num > 0, num };
    }
  }
}
