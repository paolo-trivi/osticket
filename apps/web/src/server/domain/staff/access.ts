import "server-only";

import { db, type DbOrTx } from "../../db";
import type { Agent } from "./staff";

/** StaffDeptAccess::FLAG_ALERTS (include/class.staff.php): avvisi email per il reparto. */
const ACCESS_FLAG_ALERTS = 0x0001;

export interface AgentAccess {
  primary: { dept: string; role: string };
  extended: { dept: string; role: string; alerts: boolean }[];
  teams: string[];
}

/** Reparto principale, accessi estesi (staff_dept_access) e team di un agente, con i nomi. */
export async function loadAgentAccess(agent: Agent, executor: DbOrTx = db()): Promise<AgentAccess> {
  const deptIds = [agent.deptId, ...agent.extendedAccess.map((a) => a.deptId)];
  const roleIds = agent.extendedAccess.map((a) => a.roleId);
  const teamIds = agent.teamIds.filter(Boolean);
  const [depts, roles, teams] = await Promise.all([
    executor.selectFrom("department").select(["id", "name"]).where("id", "in", deptIds).execute(),
    roleIds.length ? executor.selectFrom("role").select(["id", "name"]).where("id", "in", roleIds).execute() : Promise.resolve([]),
    teamIds.length ? executor.selectFrom("team").select("name").where("team_id", "in", teamIds).orderBy("name").execute() : Promise.resolve([]),
  ]);
  const deptName = new Map(depts.map((d) => [d.id, d.name]));
  const roleName = new Map(roles.map((r) => [r.id, r.name]));
  return {
    primary: { dept: deptName.get(agent.deptId) ?? "", role: agent.primaryRole.name },
    extended: agent.extendedAccess
      .map((a) => ({ dept: deptName.get(a.deptId) ?? "", role: roleName.get(a.roleId) ?? "", alerts: (a.flags & ACCESS_FLAG_ALERTS) !== 0 }))
      .sort((a, b) => a.dept.localeCompare(b.dept)),
    teams: teams.map((t) => t.name),
  };
}
