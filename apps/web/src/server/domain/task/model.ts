import "server-only";

import { sql } from "kysely";

import type { ConfigNamespace } from "../../config/config";
import { NOW, table, type DbOrTx } from "../../db";
import { PersonsName } from "../../format/persons-name";
import type { Agent } from "../staff/staff";
import type { WriteContext } from "../ticket/context";
import { logThreadEvent, type Actor, type EventState } from "../ticket/events";
import { DeptFlag } from "../ticket/status";

/** Riga `task` (TaskModel) */
export interface TaskDbRow {
  id: number;
  object_id: number;
  object_type: string;
  number: string;
  dept_id: number;
  staff_id: number;
  team_id: number;
  lock_id: number;
  flags: number;
  duedate: string | null;
  closed: string | null;
  created: string;
  updated: string;
}

export async function loadTaskRow(executor: DbOrTx, id: number, forUpdate = false): Promise<TaskDbRow | null> {
  let q = executor.selectFrom("task").selectAll().where("id", "=", id);
  if (forUpdate) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  return (row as unknown as TaskDbRow | undefined) ?? null;
}

export async function taskThreadId(executor: DbOrTx, taskId: number): Promise<number> {
  const th = await executor.selectFrom("thread").select("id").where("object_type", "=", "A").where("object_id", "=", taskId).executeTakeFirst();
  return th?.id ?? 0;
}

/** Task::logEvent → ThreadEvents::log con ThreadEvent::forTask (staff/team/reparto del task). */
export async function logTaskEvent(
  ctx: WriteContext,
  task: TaskDbRow,
  threadId: number,
  state: EventState,
  data?: Record<string, unknown> | null,
  who?: string | Actor,
  annul?: EventState,
): Promise<void> {
  const empty = !data || (typeof data === "object" && !Array.isArray(data) && Object.keys(data).length === 0);
  await logThreadEvent(ctx.tx, {
    threadId,
    threadType: "A",
    state,
    data: empty ? null : data,
    actor: ctx.actor,
    who,
    annul,
    staffId: task.staff_id || 0,
    teamId: task.team_id || 0,
    deptId: task.dept_id,
    topicId: 0,
  });
}

/** json_encode di un AgentsName (eventi "assigned"): {"format":…,"parts":{"first","last"},"name"} */
export function agentsNameJson(first: string, last: string, cfg: ConfigNamespace): Record<string, unknown> {
  const n = new PersonsName({ first, last }, cfg.str("agent_name_format"));
  return { format: n.format, parts: { first, last }, name: n.name };
}

export function agentName(agent: Agent, cfg: ConfigNamespace): string {
  return new PersonsName({ first: agent.name.first, last: agent.name.last }, cfg.str("agent_name_format")).toString();
}

/** Dept::getMembers() ordinati come Staff::nsort (formato del nome agente). */
async function deptMembers(executor: DbOrTx, deptId: number, cfg: ConfigNamespace, alertsOnly: boolean): Promise<number[]> {
  const d = await executor.selectFrom("department").select(["group_membership", "manager_id"]).where("id", "=", deptId).executeTakeFirst();
  if (!d) return [];
  if (alertsOnly && d.group_membership === 2) return [];
  const order = ["last", "lastfirst", "legal"].includes(cfg.str("agent_name_format")) ? sql`S.lastname, S.firstname` : sql`S.firstname, S.lastname`;
  const alertCond = alertsOnly
    ? sql`AND S.isactive = 1 AND S.onvacation = 0 AND (S.dept_id = ${deptId} OR (${d.group_membership} = 1 AND (A.flags & 1) != 0))`
    : sql``;
  const { rows } = await sql<{ staff_id: number }>`SELECT DISTINCT S.staff_id, S.firstname, S.lastname FROM ${table("staff")} S
    LEFT JOIN ${table("staff_dept_access")} A ON (A.staff_id = S.staff_id AND A.dept_id = ${deptId})
    WHERE (S.dept_id = ${deptId} OR S.staff_id = ${d.manager_id} OR A.dept_id = ${deptId}) ${alertCond}
    ORDER BY ${order}`.execute(executor);
  return rows.map((r) => r.staff_id);
}

/** Dept::getMembersForAlerts */
export function deptMembersForAlerts(executor: DbOrTx, deptId: number, cfg: ConfigNamespace): Promise<number[]> {
  return deptMembers(executor, deptId, cfg, true);
}

/** Team::getMembersForAlerts (membri con flag alert, ordine della tabella) */
export async function teamMembersForAlerts(executor: DbOrTx, teamId: number): Promise<number[]> {
  const rows = await executor
    .selectFrom("team_member")
    .select("staff_id")
    .where("team_id", "=", teamId)
    .where(sql<boolean>`(flags & 1) != 0`)
    .orderBy("staff_id")
    .execute();
  return rows.map((r) => r.staff_id);
}

/** Dept::canAssign($staff) */
export async function deptCanAssign(executor: DbOrTx, deptId: number, staff: Agent, cfg: ConfigNamespace): Promise<boolean> {
  const d = await executor.selectFrom("department").select(["flags"]).where("id", "=", deptId).executeTakeFirst();
  if (!d) return false;
  if (d.flags & DeptFlag.ASSIGN_PRIMARY_ONLY && staff.deptId !== deptId) return false;
  if (d.flags & DeptFlag.ASSIGN_MEMBERS_ONLY && !(await deptMembers(executor, deptId, cfg, false)).includes(staff.id)) return false;
  return staff.isAvailable;
}

interface TeamInfo {
  team_id: number;
  name: string;
  flags: number;
  lead_id: number;
  members: number;
}

export async function loadTeam(executor: DbOrTx, teamId: number): Promise<TeamInfo | null> {
  const t = await executor.selectFrom("team").select(["team_id", "name", "flags", "lead_id"]).where("team_id", "=", teamId).executeTakeFirst();
  if (!t) return null;
  const { rows } = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM ${table("team_member")} WHERE team_id = ${teamId}`.execute(executor);
  return { ...t, members: Number(rows[0]?.n ?? 0) };
}

/** UPDATE dei soli campi indicati della riga task (save() dell'ORM con i campi modificati). */
export async function updateTaskRow(executor: DbOrTx, task: TaskDbRow, values: Partial<Record<keyof TaskDbRow, unknown>>): Promise<void> {
  if (!Object.keys(values).length) return;
  const set: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) set[k] = v === "NOW" ? NOW : v;
  await executor.updateTable("task").set(set as never).where("id", "=", task.id).execute();
  const fresh = await loadTaskRow(executor, task.id);
  if (fresh) Object.assign(task, fresh);
}

/**
 * Agenti selezionabili come assegnatari (AssigneeField::getAssignees): Dept::getAssignees se c'è un
 * reparto (tutti gli agenti disponibili, o i soli membri se il reparto limita l'assegnazione), altrimenti
 * Staff::getStaffMembers; filtrati da Staff::applyDeptVisibility dell'assegnante. Ordinati per nome.
 */
export async function assignableAgents(executor: DbOrTx, deptId: number | null, assigner: Agent | null, cfg: ConfigNamespace) {
  const conds = [sql`S.isactive = 1 AND S.onvacation = 0`];
  if (deptId) {
    const d = await executor.selectFrom("department").select(["flags"]).where("id", "=", deptId).executeTakeFirst();
    const primaryOnly = !!d && (d.flags & DeptFlag.ASSIGN_PRIMARY_ONLY) !== 0;
    const membersOnly = !!d && (d.flags & DeptFlag.ASSIGN_MEMBERS_ONLY) !== 0;
    if (primaryOnly) conds.push(sql`S.dept_id = ${deptId}`);
    else if (membersOnly) {
      const ids = await deptMembers(executor, deptId, cfg, false);
      conds.push(ids.length ? sql`S.staff_id IN (${sql.join(ids)})` : sql`0 = 1`);
    }
  }
  if (assigner && !assigner.hasGlobalPerm("visibility.agents") && assigner.deptIds.length) {
    const depts = sql.join([...assigner.deptIds]);
    conds.push(sql`(S.dept_id IN (${depts}) OR EXISTS (SELECT 1 FROM ${table("staff_dept_access")} X WHERE X.staff_id = S.staff_id AND X.dept_id IN (${depts})))`);
  }
  const order = ["last", "lastfirst", "legal"].includes(cfg.str("agent_name_format")) ? sql`S.lastname, S.firstname` : sql`S.firstname, S.lastname`;
  const { rows } = await sql<{ staff_id: number; firstname: string | null; lastname: string | null }>`
    SELECT S.staff_id, S.firstname, S.lastname FROM ${table("staff")} S WHERE ${sql.join(conds, sql` AND `)} ORDER BY ${order}`.execute(executor);
  return rows.map((r) => ({
    id: r.staff_id,
    name: new PersonsName({ first: r.firstname ?? "", last: r.lastname ?? "" }, cfg.str("agent_name_format")).toString(),
  }));
}

/** Team::getActiveTeams() */
export async function activeTeams(executor: DbOrTx) {
  const { rows } = await sql<{ team_id: number; name: string }>`SELECT T.team_id, T.name FROM ${table("team")} T
    WHERE (T.flags & 1) != 0 AND EXISTS (SELECT 1 FROM ${table("team_member")} M WHERE M.team_id = T.team_id) ORDER BY T.name`.execute(executor);
  return rows.map((r) => ({ id: r.team_id, name: r.name }));
}
