import "server-only";

import { sql, type RawBuilder } from "kysely";

import { db, table, type DbOrTx } from "../../db";
import type { DbDateTime } from "../../db/schema.gen";
import type { Agent } from "../staff/staff";

/** Task (class.task.php, include/staff/tasks.inc.php) in sola lettura. */
export const TaskFlag = { ISOPEN: 0x0001, ISOVERDUE: 0x0002 } as const;

export type TaskQueueName = "open" | "closed" | "assigned" | "overdue";

export interface TaskRow {
  id: number;
  number: string;
  title: string | null;
  created: DbDateTime;
  updated: DbDateTime;
  closed: DbDateTime | null;
  duedate: DbDateTime | null;
  flags: number;
  dept_id: number;
  dept_name: string | null;
  staff_id: number;
  staff_name: string | null;
  team_id: number;
  team_name: string | null;
  ticket_id: number | null;
  ticket_number: string | null;
  thread_id: number | null;
}

/** Visibilità della lista task (tasks.inc.php). */
function taskVisibility(agent: Agent): RawBuilder<unknown> {
  const parts: RawBuilder<unknown>[] = [
    sql`((K.flags & ${TaskFlag.ISOPEN}) != 0 AND K.staff_id = ${agent.id})`,
    sql`(TK.staff_id = ${agent.id} AND TS.state = 'open')`,
  ];
  if (!agent.isAccessLimited && agent.deptIds.length) parts.push(sql`K.dept_id IN (${sql.join([...agent.deptIds])})`);
  const teams = agent.teamIds.filter(Boolean);
  if (teams.length) parts.push(sql`(K.team_id IN (${sql.join(teams)}) AND (K.flags & ${TaskFlag.ISOPEN}) != 0)`);
  return sql`(${sql.join(parts, sql` OR `)})`;
}

const FROM = () => sql`FROM ${table("task")} K
  LEFT JOIN ${table("task__cdata")} KC ON (KC.task_id = K.id)
  LEFT JOIN ${table("department")} D ON (D.id = K.dept_id)
  LEFT JOIN ${table("staff")} S ON (S.staff_id = K.staff_id)
  LEFT JOIN ${table("team")} TM ON (TM.team_id = K.team_id)
  LEFT JOIN ${table("ticket")} TK ON (K.object_type = 'T' AND TK.ticket_id = K.object_id)
  LEFT JOIN ${table("ticket_status")} TS ON (TS.id = TK.status_id)
  LEFT JOIN ${table("thread")} TH ON (TH.object_type = 'A' AND TH.object_id = K.id)`;

const SELECT = sql`SELECT K.id, K.number, KC.title, K.created, K.updated, K.closed, K.duedate, K.flags,
  K.dept_id, D.name AS dept_name, K.staff_id, NULLIF(CONCAT_WS(' ', S.firstname, S.lastname), '') AS staff_name,
  K.team_id, TM.name AS team_name, TK.ticket_id, TK.number AS ticket_number, TH.id AS thread_id`;

export async function listTasks(
  agent: Agent,
  opts: { queue: TaskQueueName; q?: string; ticketId?: number; page: number; pageSize: number },
  executor: DbOrTx = db(),
): Promise<{ rows: TaskRow[]; total: number }> {
  const conds: RawBuilder<unknown>[] = [taskVisibility(agent)];
  if (opts.ticketId) conds.push(sql`K.object_type = 'T' AND K.object_id = ${opts.ticketId}`);
  else if (opts.q) {
    conds.push(sql`(K.number LIKE ${opts.q + "%"} OR KC.title LIKE ${"%" + opts.q + "%"})`);
  } else {
    if (opts.queue === "closed") conds.push(sql`(K.flags & ${TaskFlag.ISOPEN}) = 0`);
    else conds.push(sql`(K.flags & ${TaskFlag.ISOPEN}) != 0`);
    if (opts.queue === "overdue") conds.push(sql`(K.flags & ${TaskFlag.ISOVERDUE}) != 0`);
    if (opts.queue === "assigned") conds.push(sql`K.staff_id = ${agent.id}`);
  }
  const where = sql.join(conds, sql` AND `);
  const order = opts.queue === "closed" ? sql`K.closed DESC` : opts.queue === "open" ? sql`K.created DESC` : sql`K.updated DESC`;
  const [{ rows }, { rows: count }] = await Promise.all([
    sql<TaskRow>`${SELECT} ${FROM()} WHERE ${where} ORDER BY ${order}
      LIMIT ${opts.pageSize} OFFSET ${(opts.page - 1) * opts.pageSize}`.execute(executor),
    sql<{ n: number }>`SELECT COUNT(*) AS n ${FROM()} WHERE ${where}`.execute(executor),
  ]);
  return { rows, total: Number(count[0]?.n ?? 0) };
}

export async function loadTask(id: number, executor: DbOrTx = db()): Promise<TaskRow | null> {
  const { rows } = await sql<TaskRow>`${SELECT} ${FROM()} WHERE K.id = ${id}`.execute(executor);
  return rows[0] ?? null;
}

/**
 * Task::checkStaffPerm. Nota: il PHP nega solo i task APERTI di reparti non accessibili (i chiusi restano
 * visibili a chiunque, bug documentato in doc 14); qui l'accesso richiede sempre reparto o assegnazione.
 */
export function checkTaskPerm(task: TaskRow, agent: Agent, perm?: string): boolean {
  const assigned = (task.flags & TaskFlag.ISOPEN) !== 0 && (task.staff_id === agent.id || agent.isTeamMember(task.team_id));
  if (!agent.canAccessDept(task.dept_id) && !assigned) return false;
  if (!perm) return true;
  return agent.roleFor(task.dept_id).perms.has(perm);
}
