import "server-only";

import { sql } from "kysely";

import { Dept, Team } from "@/lib/osticket/flags";

import { table, type DbOrTx } from "../../db";
import { PersonsName } from "../../format/persons-name";
import { GlobalPerm, type Agent } from "../staff/staff";
import { deptIsMember, loadDept, staffSortColumns, type DeptRow } from "./alerts";

/**
 * Scelta ed elenco degli assegnatari di un ticket (include/class.dept.php, class.team.php,
 * class.staff.php): agenti e team assegnabili, disponibilità, Dept::canAssign e reparti selezionabili.
 */

export interface StaffBasic {
  staff_id: number;
  dept_id: number;
  firstname: string;
  lastname: string;
  isactive: number;
  onvacation: number;
}

export async function loadStaffBasic(executor: DbOrTx, id: number): Promise<StaffBasic | null> {
  if (!id) return null;
  const s = await executor
    .selectFrom("staff")
    .select(["staff_id", "dept_id", "firstname", "lastname", "isactive", "onvacation"])
    .where("staff_id", "=", id)
    .executeTakeFirst();
  return s ? { ...s, firstname: s.firstname ?? "", lastname: s.lastname ?? "" } : null;
}

export const available = (s: { isactive: number; onvacation: number }) => !!s.isactive && !s.onvacation;

/** (string) AgentsName::getOriginal(): implode(' ', [first, last]) */
export const originalName = (s: { firstname: string; lastname: string }) => `${s.firstname} ${s.lastname}`;

/** Dept::canAssign($staff) */
export async function deptCanAssignStaff(executor: DbOrTx, dept: DeptRow, staff: StaffBasic): Promise<boolean> {
  if (dept.flags & Dept.ASSIGN_PRIMARY_ONLY && staff.dept_id !== dept.id) return false;
  if (dept.flags & Dept.ASSIGN_MEMBERS_ONLY && !(await deptIsMember(executor, dept, staff.staff_id))) return false;
  return available(staff);
}

/**
 * Dept::getAssignees(['staff' => $assigner]): agenti disponibili (tutti, o solo membri/primari secondo i
 * flag del reparto), limitati dalla visibilità dell'assegnatore (Staff::applyDeptVisibility).
 */
export async function assignableAgents(executor: DbOrTx, deptId: number, assigner: Agent, nameFormat: string): Promise<{ id: number; name: string }[]> {
  const dept = await loadDept(executor, deptId);
  if (!dept) return [];
  const restricted = !!(dept.flags & (Dept.ASSIGN_MEMBERS_ONLY | Dept.ASSIGN_PRIMARY_ONLY));
  const visible = !assigner.hasGlobalPerm(GlobalPerm.VISIBILITY_AGENTS) && assigner.deptIds.length ? [...assigner.deptIds] : null;
  const [a, b] = staffSortColumns(nameFormat);
  const { rows } = await sql<{ staff_id: number; firstname: string | null; lastname: string | null }>`
    SELECT DISTINCT S.staff_id, S.firstname, S.lastname FROM ${table("staff")} S
    LEFT JOIN ${table("staff_dept_access")} A ON (A.staff_id = S.staff_id ${restricted ? sql`AND A.dept_id = ${dept.id}` : sql``})
    ${visible ? sql`LEFT JOIN ${table("staff_dept_access")} V ON (V.staff_id = S.staff_id)` : sql``}
    WHERE S.isactive = 1 AND S.onvacation = 0
    ${restricted ? sql`AND (S.dept_id = ${dept.id} OR S.staff_id = ${dept.manager_id} OR A.dept_id = ${dept.id})` : sql``}
    ${dept.flags & Dept.ASSIGN_PRIMARY_ONLY ? sql`AND S.dept_id = ${dept.id}` : sql``}
    ${visible ? sql`AND (S.dept_id IN (${sql.join(visible)}) OR V.dept_id IN (${sql.join(visible)}))` : sql``}
    ORDER BY S.${sql.ref(a)}, S.${sql.ref(b)}`.execute(executor);
  return rows.map((r) => ({ id: r.staff_id, name: new PersonsName({ first: r.firstname ?? "", last: r.lastname ?? "" }, nameFormat).toString() }));
}

/** Team::getActiveTeams(): team abilitati con almeno un membro attivo e non in ferie, per nome. */
export async function activeTeams(executor: DbOrTx): Promise<{ id: number; name: string }[]> {
  const { rows } = await sql<{ team_id: number; name: string }>`SELECT T.team_id, T.name FROM ${table("team")} T
    JOIN ${table("team_member")} M ON (M.team_id = T.team_id)
    JOIN ${table("staff")} S ON (S.staff_id = M.staff_id)
    WHERE (T.flags & ${Team.ENABLED}) != 0 AND S.isactive = 1 AND S.onvacation = 0
    GROUP BY T.team_id, T.name HAVING COUNT(M.staff_id) > 0 ORDER BY T.name`.execute(executor);
  return rows.map((r) => ({ id: r.team_id, name: r.name }));
}

/**
 * Reparti proposti da DepartmentField con hideDisabled: tutti i reparti attivi se l'agente ha
 * visibility.departments, altrimenti solo quelli a cui ha accesso (più quello selezionato).
 */
export async function selectableDepts(executor: DbOrTx, agent: Agent, selected: number | null): Promise<{ id: number; name: string }[]> {
  const rows = await executor
    .selectFrom("department")
    .select(["id", "name"])
    .where(sql<boolean>`(flags & ${Dept.ACTIVE}) != 0`)
    .orderBy("name")
    .execute();
  const all = rows.map((r) => ({ id: r.id, name: r.name ?? "" }));
  if (agent.hasGlobalPerm(GlobalPerm.VISIBILITY_DEPTS)) return all;
  return all.filter((d) => agent.deptIds.includes(d.id) || d.id === selected);
}
