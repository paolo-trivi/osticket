import "server-only";

import { sql } from "kysely";

import { NOW, table, type DbOrTx } from "../../db";
import { PersonsName } from "../../format/persons-name";
import { loadStaffInfo, staffVar } from "../../mail/objects";
import { VarBag } from "../../mail/variables";
import { GlobalPerm, TicketPerm, type Agent } from "../staff/staff";
import { deptAlertEmail, deptAlertMembers, deptIsMember, loadDept, sendStaffAlerts, staffSortColumns, teamAlertMembers, type DeptRow } from "./alerts";
import { agentDisplayName, type WriteContext } from "./context";
import { logNote, postNote, ticketThreadId } from "./post";
import { logTicketEvent } from "./events";
import { TicketRecord } from "./record";
import { DeptFlag, stateOf } from "./status";
import { checkStaffPerm, loadTicket } from "./ticket";
import { reopenTicket, type ActionResult } from "./ticket-state";

/**
 * Assegnazione, presa in carico, rilascio e referral di un ticket da parte di un agente
 * (include/class.ticket.php: assign, claim, assignToStaff, assignToTeam, onAssign, release, unassign,
 * refer; include/ajax.tickets.php: assign, claim, release, refer).
 */

/** ObjectModel::OBJECT_TYPE_* usati da thread_referral */
export type ReferralType = "S" | "E" | "D";

const TeamFlag = { ENABLED: 0x1, NOALERTS: 0x2 } as const;

// --- Referral (Thread::refer / getReferral) ---------------------------------------------

export async function findReferral(executor: DbOrTx, threadId: number, type: ReferralType, objectId: number) {
  return executor
    .selectFrom("thread_referral")
    .select("id")
    .where("thread_id", "=", threadId)
    .where("object_type", "=", type)
    .where("object_id", "=", objectId)
    .executeTakeFirst();
}

/** Ticket::hasReferral($obj, $type) + $referral->delete() */
export async function deleteReferralOf(executor: DbOrTx, threadId: number, type: ReferralType, objectId: number): Promise<void> {
  const r = await findReferral(executor, threadId, type, objectId);
  if (r) await executor.deleteFrom("thread_referral").where("id", "=", r.id).execute();
}

/** Thread::refer($to): isReferred($to, strict) e ThreadReferral::create. */
export async function threadRefer(executor: DbOrTx, threadId: number, type: ReferralType, objectId: number): Promise<boolean> {
  if (await findReferral(executor, threadId, type, objectId)) return false;
  await executor.insertInto("thread_referral").values({ thread_id: threadId, object_id: objectId, object_type: type, created: NOW }).execute();
  return true;
}

// --- Agenti e team assegnabili ------------------------------------------------------------

interface StaffBasic {
  staff_id: number;
  dept_id: number;
  firstname: string;
  lastname: string;
  isactive: number;
  onvacation: number;
}

async function loadStaffBasic(executor: DbOrTx, id: number): Promise<StaffBasic | null> {
  if (!id) return null;
  const s = await executor
    .selectFrom("staff")
    .select(["staff_id", "dept_id", "firstname", "lastname", "isactive", "onvacation"])
    .where("staff_id", "=", id)
    .executeTakeFirst();
  return s ? { ...s, firstname: s.firstname ?? "", lastname: s.lastname ?? "" } : null;
}

const available = (s: { isactive: number; onvacation: number }) => !!s.isactive && !s.onvacation;

/** (string) AgentsName::getOriginal(): implode(' ', [first, last]) */
const originalName = (s: { firstname: string; lastname: string }) => `${s.firstname} ${s.lastname}`;

/** Dept::canAssign($staff) */
export async function deptCanAssignStaff(executor: DbOrTx, dept: DeptRow, staff: StaffBasic): Promise<boolean> {
  if (dept.flags & DeptFlag.ASSIGN_PRIMARY_ONLY && staff.dept_id !== dept.id) return false;
  if (dept.flags & DeptFlag.ASSIGN_MEMBERS_ONLY && !(await deptIsMember(executor, dept, staff.staff_id))) return false;
  return available(staff);
}

/**
 * Dept::getAssignees(['staff' => $assigner]): agenti disponibili (tutti, o solo membri/primari secondo i
 * flag del reparto), limitati dalla visibilità dell'assegnatore (Staff::applyDeptVisibility).
 */
export async function assignableAgents(executor: DbOrTx, deptId: number, assigner: Agent, nameFormat: string): Promise<{ id: number; name: string }[]> {
  const dept = await loadDept(executor, deptId);
  if (!dept) return [];
  const restricted = !!(dept.flags & (DeptFlag.ASSIGN_MEMBERS_ONLY | DeptFlag.ASSIGN_PRIMARY_ONLY));
  const visible = !assigner.hasGlobalPerm(GlobalPerm.VISIBILITY_AGENTS) && assigner.deptIds.length ? [...assigner.deptIds] : null;
  const [a, b] = staffSortColumns(nameFormat);
  const { rows } = await sql<{ staff_id: number; firstname: string | null; lastname: string | null }>`
    SELECT DISTINCT S.staff_id, S.firstname, S.lastname FROM ${table("staff")} S
    LEFT JOIN ${table("staff_dept_access")} A ON (A.staff_id = S.staff_id ${restricted ? sql`AND A.dept_id = ${dept.id}` : sql``})
    ${visible ? sql`LEFT JOIN ${table("staff_dept_access")} V ON (V.staff_id = S.staff_id)` : sql``}
    WHERE S.isactive = 1 AND S.onvacation = 0
    ${restricted ? sql`AND (S.dept_id = ${dept.id} OR S.staff_id = ${dept.manager_id} OR A.dept_id = ${dept.id})` : sql``}
    ${dept.flags & DeptFlag.ASSIGN_PRIMARY_ONLY ? sql`AND S.dept_id = ${dept.id}` : sql``}
    ${visible ? sql`AND (S.dept_id IN (${sql.join(visible)}) OR V.dept_id IN (${sql.join(visible)}))` : sql``}
    ORDER BY S.${sql.ref(a)}, S.${sql.ref(b)}`.execute(executor);
  return rows.map((r) => ({ id: r.staff_id, name: new PersonsName({ first: r.firstname ?? "", last: r.lastname ?? "" }, nameFormat).toString() }));
}

/** Team::getActiveTeams(): team abilitati con almeno un membro attivo e non in ferie, per nome. */
export async function activeTeams(executor: DbOrTx): Promise<{ id: number; name: string }[]> {
  const { rows } = await sql<{ team_id: number; name: string }>`SELECT T.team_id, T.name FROM ${table("team")} T
    JOIN ${table("team_member")} M ON (M.team_id = T.team_id)
    JOIN ${table("staff")} S ON (S.staff_id = M.staff_id)
    WHERE (T.flags & ${TeamFlag.ENABLED}) != 0 AND S.isactive = 1 AND S.onvacation = 0
    GROUP BY T.team_id, T.name HAVING COUNT(M.staff_id) > 0 ORDER BY T.name`.execute(executor);
  return rows.map((r) => ({ id: r.team_id, name: r.name }));
}

// --- onAssign -----------------------------------------------------------------------------

type Assignee = { kind: "staff"; staff: StaffBasic } | { kind: "team"; id: number; name: string; flags: number; leadId: number };

/** Ticket::onAssign: riapertura se chiuso, nota con i commenti, avvisi 'assigned.alert'. */
async function onAssign(ctx: WriteContext, rec: TicketRecord, threadId: number, assignee: Assignee, comments: string, alert: boolean): Promise<void> {
  const { tx, cfg, agent } = ctx;
  if ((await stateOf(tx, rec.row)) === "closed") await reopenTicket(ctx, rec, threadId);

  let note: { entryId: number } | null = null;
  if (comments) {
    const self = assignee.kind === "staff" && agent && assignee.staff.staff_id === agent.id;
    const assigneeName =
      assignee.kind === "staff" ? new PersonsName({ first: assignee.staff.firstname, last: assignee.staff.lastname }, cfg.str("agent_name_format")).toString() : assignee.name;
    const title = self && agent ? `Ticket claimed by ${agentDisplayName(agent, cfg)}` : `Ticket Assigned to ${assigneeName}`;
    const r = await postNote(ctx, { ticketId: rec.id, note: comments, title, format: "html", alert: false });
    if ("entryId" in r) note = r;
  }

  const dept = await loadDept(tx, rec.get("dept_id"));
  if (!alert || !cfg.bool("assigned_alert_active") || !dept || !(await deptAlertMembers(tx, dept, cfg.str("agent_name_format"))).length) return;
  const email = await deptAlertEmail(ctx, dept);
  if (!email) return;

  const recipients: number[] = [];
  if (assignee.kind === "staff") {
    if (cfg.bool("assigned_alert_staff")) recipients.push(assignee.staff.staff_id);
  } else if (!(assignee.flags & TeamFlag.NOALERTS)) {
    const members = cfg.bool("assigned_alert_team_members") ? await teamAlertMembers(tx, assignee.id) : [];
    if (members.length) recipients.push(...members);
    else if (cfg.bool("assigned_alert_team_lead") && assignee.leadId) recipients.push(assignee.leadId);
  }
  if (!recipients.length) return;

  let assigneeVar: unknown;
  if (assignee.kind === "staff") {
    const info = await loadStaffInfo(tx, assignee.staff.staff_id);
    assigneeVar = info ? staffVar(info, cfg) : null;
  } else {
    assigneeVar = new VarBag({ name: assignee.name, id: assignee.id, lead: "" }, assignee.name);
  }
  const assignerInfo = agent ? await loadStaffInfo(tx, agent.id) : null;
  await sendStaffAlerts(ctx, {
    ticketId: rec.id,
    deptId: dept.id,
    code: "assigned.alert",
    email,
    vars: { comments: comments || "", assignee: assigneeVar, assigner: assignerInfo ? staffVar(assignerInfo, cfg) : "SYSTEM (Auto Assignment)" },
    recipients,
    thread: note ? { entryId: note.entryId, threadId } : null,
  });
}

// --- Assegnazione -------------------------------------------------------------------------

export interface AssignInput {
  ticketId: number;
  /** "s<id>" agente, "t<id>" team (valori del campo AssigneeField) */
  assignee: string;
  /** mantieni il referral al precedente assegnatario */
  refer?: boolean;
  /** commenti (HTML già sanificato) */
  comments?: string;
  alert?: boolean;
}

async function loadForAction(
  ctx: WriteContext,
  ticketId: number,
  perm?: string,
): Promise<{ error: string } | { agent: Agent; t: Awaited<ReturnType<typeof loadTicket>> & object; rec: TicketRecord; threadId: number }> {
  const { tx, agent } = ctx;
  if (!agent) return { error: "denied" };
  const t = await loadTicket(ticketId, agent.id, tx);
  if (!t) return { error: "not_found" };
  if (!(await checkStaffPerm(t, agent, perm, tx))) return { error: perm ? "denied" : "not_found" };
  const rec = await TicketRecord.load(tx, ticketId, true);
  if (!rec) return { error: "not_found" };
  return { agent, t, rec, threadId: await ticketThreadId(tx, ticketId) };
}

/** ajax.tickets.php:assign → AssignmentForm::isValid → Ticket::assign. */
export async function assignTicket(ctx: WriteContext, input: AssignInput): Promise<ActionResult> {
  const { tx, cfg } = ctx;
  const loaded = await loadForAction(ctx, input.ticketId, TicketPerm.ASSIGN);
  if (!("agent" in loaded)) return { error: loaded.error };
  const { agent, rec, threadId } = loaded;
  const m = /^([st])(\d+)$/.exec(input.assignee ?? "");
  if (!m) return { error: "assignee_required" };
  const id = Number(m[2]);
  const dept = await loadDept(tx, rec.get("dept_id"));
  if (!dept) return { error: "not_found" };

  // AssigneeField: la scelta deve essere tra quelle proposte; AssignmentForm::isValid
  let assignee: Assignee;
  if (m[1] === "s") {
    const choices = await assignableAgents(tx, dept.id, agent, cfg.str("agent_name_format"));
    if (!choices.some((c) => c.id === id)) return { error: "unknown_assignee" };
    const staff = await loadStaffBasic(tx, id);
    if (!staff) return { error: "unknown_assignee" };
    if (!available(staff)) return { error: "agent_unavailable" };
    assignee = { kind: "staff", staff };
  } else {
    if (!(await activeTeams(tx)).some((c) => c.id === id)) return { error: "unknown_assignee" };
    const team = await tx.selectFrom("team").select(["team_id", "name", "flags", "lead_id"]).where("team_id", "=", id).executeTakeFirst();
    if (!team) return { error: "unknown_assignee" };
    if (!(team.flags & TeamFlag.ENABLED)) return { error: "team_disabled" };
    const members = await tx.selectFrom("team_member").select("staff_id").where("team_id", "=", id).execute();
    if (!members.length) return { error: "team_no_members" };
    assignee = { kind: "team", id: team.team_id, name: team.name, flags: team.flags, leadId: team.lead_id };
  }

  // Ticket::assign
  let alert = input.alert ?? true;
  let evd: Record<string, unknown> = {};
  let refer: { type: ReferralType; id: number } | null = null;
  if (assignee.kind === "staff") {
    const staff = assignee.staff;
    if (rec.get("staff_id") === staff.staff_id) return { error: "already_assigned_agent" };
    if (!(await deptCanAssignStaff(tx, dept, staff))) return { error: "denied" };
    // $this->staff ?: null — l'agente deve esistere
    if (rec.get("staff_id") && (await loadStaffBasic(tx, rec.get("staff_id")))) refer = { type: "S", id: rec.get("staff_id") };
    rec.set("staff_id", staff.staff_id);
    if (staff.staff_id === agent.id) {
      alert = false;
      evd = { claim: true };
    } else {
      evd = { staff: [staff.staff_id, originalName(staff)] };
    }
    await deleteReferralOf(tx, threadId, "S", staff.staff_id);
  } else {
    if (rec.get("team_id") === assignee.id) return { error: "already_assigned_team" };
    // Dept::canAssign($team) → Team::isAvailable(): abilitato (la relazione members è sempre "vera")
    if (!(assignee.flags & TeamFlag.ENABLED)) return { error: "denied" };
    if (rec.get("team_id") && (await tx.selectFrom("team").select("team_id").where("team_id", "=", rec.get("team_id")).executeTakeFirst()))
      refer = { type: "E", id: rec.get("team_id") };
    rec.set("team_id", assignee.id);
    evd = { team: assignee.id };
    await deleteReferralOf(tx, threadId, "E", assignee.id);
  }
  await rec.save(true);
  await logTicketEvent(tx, rec.row, threadId, ctx.actor, "assigned", evd);
  await onAssign(ctx, rec, threadId, assignee, input.comments ?? "", alert);
  if (refer && input.refer) await threadRefer(tx, threadId, refer.type, refer.id);
  return { ok: true };
}

/** Ticket::assignToStaff($staff, $note, $alert): assegnazione diretta (presa in carico, sistema). */
export async function assignToStaff(ctx: WriteContext, rec: TicketRecord, threadId: number, staffId: number, note: string, alert = true): Promise<boolean> {
  const { tx, agent } = ctx;
  const staff = await loadStaffBasic(tx, staffId);
  if (!staff || !available(staff)) return false;
  rec.set("staff_id", staff.staff_id);
  await rec.save();
  await onAssign(ctx, rec, threadId, { kind: "staff", staff }, note, alert);
  const data = agent && staff.staff_id === agent.id ? { claim: true } : { staff: staff.staff_id };
  await logTicketEvent(tx, rec.row, threadId, ctx.actor, "assigned", data);
  await deleteReferralOf(tx, threadId, "S", staff.staff_id);
  return true;
}

/** Ticket::assignToTeam($team, $note, $alert) */
export async function assignToTeam(ctx: WriteContext, rec: TicketRecord, threadId: number, teamId: number, note: string, alert = true): Promise<boolean> {
  const { tx } = ctx;
  const team = await tx.selectFrom("team").select(["team_id", "name", "flags", "lead_id"]).where("team_id", "=", teamId).executeTakeFirst();
  if (!team || !(team.flags & TeamFlag.ENABLED)) return false;
  rec.set("team_id", team.team_id);
  await rec.save();
  // staff_id è sovraccarico (assegnatario e chi ha chiuso): azzerato sui ticket chiusi
  if ((await stateOf(tx, rec.row)) === "closed") {
    rec.set("staff_id", 0);
    await rec.save();
  }
  await onAssign(ctx, rec, threadId, { kind: "team", id: team.team_id, name: team.name, flags: team.flags, leadId: team.lead_id }, note, alert);
  await logTicketEvent(tx, rec.row, threadId, ctx.actor, "assigned", { team: team.team_id });
  await deleteReferralOf(tx, threadId, "E", team.team_id);
  return true;
}

/** ajax.tickets.php:claim → ClaimForm → Ticket::claim → assignToStaff($thisstaff, comments, false). */
export async function claimTicket(ctx: WriteContext, input: { ticketId: number; comments?: string }): Promise<ActionResult> {
  const { tx } = ctx;
  const loaded = await loadForAction(ctx, input.ticketId, TicketPerm.ASSIGN);
  if (!("agent" in loaded)) return { error: loaded.error };
  const { agent, rec, threadId } = loaded;
  // Solo ticket aperti e senza agente assegnato (getStaff(): agente esistente)
  if ((await stateOf(tx, rec.row)) !== "open") return { error: "denied" };
  if (rec.get("staff_id") && (await loadStaffBasic(tx, rec.get("staff_id")))) return { error: "denied" };
  const me = await loadStaffBasic(tx, agent.id);
  const dept = await loadDept(tx, rec.get("dept_id"));
  if (!me || !dept) return { error: "denied" };
  if (!available(me)) return { error: "agent_unavailable" };
  if (!(await deptCanAssignStaff(tx, dept, me))) return { error: "denied" };
  if (!(await assignToStaff(ctx, rec, threadId, me.staff_id, input.comments ?? "", false))) return { error: "assign_failed" };
  return { ok: true };
}

// --- Rilascio -----------------------------------------------------------------------------

/**
 * ajax.tickets.php:release → Ticket::release($info): rilascio dell'agente, del team o di entrambi
 * (unassign), evento 'released' con chi è stato rilasciato, nota "Assignment Released" con i commenti.
 * Permessi: PERM_RELEASE oppure manager del reparto del ticket. Il PHP accetta il manager del reparto
 * PRIMARIO dell'agente (Staff::isManager() senza argomenti): si applica la regola più stretta, la
 * stessa che decide la visibilità della voce nella vista ticket.
 */
export async function releaseTicket(ctx: WriteContext, input: { ticketId: number; staff?: boolean; team?: boolean; comments?: string }): Promise<ActionResult> {
  const { tx } = ctx;
  const loaded = await loadForAction(ctx, input.ticketId);
  if (!("agent" in loaded)) return { error: loaded.error };
  const { agent, t, rec, threadId } = loaded;
  const dept = await loadDept(tx, rec.get("dept_id"));
  const isManager = !!dept?.manager_id && dept.manager_id === agent.id;
  if (!(await checkStaffPerm(t, agent, TicketPerm.RELEASE, tx)) && !isManager) return { error: "denied" };
  const state = await stateOf(tx, rec.row);
  const isAssigned = state === "open" && !!(rec.get("staff_id") || rec.get("team_id"));
  if (!isAssigned) return { error: "not_assigned" };
  if (!input.staff && !input.team) return { error: "release_required" };

  const staff = await loadStaffBasic(tx, rec.get("staff_id"));
  const team = rec.get("team_id") ? await tx.selectFrom("team").select("team_id").where("team_id", "=", rec.get("team_id")).executeTakeFirst() : undefined;

  // Ticket::release / unassign: ogni azzeramento è un salvataggio separato (setStaffId/setTeamId)
  if (input.staff && input.team) {
    if (rec.get("staff_id")) {
      rec.set("staff_id", 0);
      await rec.save();
    }
    if (rec.get("team_id")) {
      rec.set("team_id", 0);
      await rec.save();
    }
  } else if (input.staff) {
    rec.set("staff_id", 0);
    await rec.save();
  } else {
    rec.set("team_id", 0);
    await rec.save();
  }

  const data: Record<string, unknown> = {};
  if (staff && !rec.get("staff_id")) data.staff = [staff.staff_id, originalName(staff)];
  if (team && !rec.get("team_id")) data.team = team.team_id;
  await logTicketEvent(tx, rec.row, threadId, ctx.actor, "released", Object.keys(data).length ? data : null);
  if (input.comments) await postNote(ctx, { ticketId: rec.id, note: input.comments, title: "Assignment Released", alert: false });
  return { ok: true };
}

// --- Referral -----------------------------------------------------------------------------

/** Scelte del form di referral (Ticket::getReferralForm). */
export async function referralChoices(executor: DbOrTx, deptId: number, agent: Agent, nameFormat: string) {
  const [a, b] = staffSortColumns(nameFormat);
  const staff = await executor
    .selectFrom("staff")
    .select(["staff_id", "firstname", "lastname"])
    .where("isactive", "=", 1)
    .where("dept_id", "!=", deptId)
    .orderBy(a)
    .orderBy(b)
    .execute();
  return {
    agents: staff.map((s) => ({ id: s.staff_id, name: new PersonsName({ first: s.firstname ?? "", last: s.lastname ?? "" }, nameFormat).toString() })),
    teams: await activeTeams(executor),
    depts: await selectableDepts(executor, agent, null),
  };
}

/**
 * Reparti proposti da DepartmentField con hideDisabled: tutti i reparti attivi se l'agente ha
 * visibility.departments, altrimenti solo quelli a cui ha accesso (più quello selezionato).
 */
export async function selectableDepts(executor: DbOrTx, agent: Agent, selected: number | null): Promise<{ id: number; name: string }[]> {
  const rows = await executor
    .selectFrom("department")
    .select(["id", "name"])
    .where(sql<boolean>`(flags & ${DeptFlag.ACTIVE}) != 0`)
    .orderBy("name")
    .execute();
  const all = rows.map((r) => ({ id: r.id, name: r.name ?? "" }));
  if (agent.hasGlobalPerm(GlobalPerm.VISIBILITY_DEPTS)) return all;
  return all.filter((d) => agent.deptIds.includes(d.id) || d.id === selected);
}

/**
 * ajax.tickets.php:refer (do=refer) → ReferralForm::isValid → Ticket::refer, poi nota "Referral" con i
 * commenti (con avvisi, come logNote). Permessi: il PHP controlla PERM_ASSIGN nell'endpoint ma mostra
 * la voce solo con PERM_REFER: si richiedono entrambi (regola più stretta).
 */
export async function referTicket(
  ctx: WriteContext,
  input: { ticketId: number; target: "agent" | "team" | "dept"; id: number; comments?: string },
): Promise<ActionResult> {
  const { tx, cfg } = ctx;
  const loaded = await loadForAction(ctx, input.ticketId, TicketPerm.ASSIGN);
  if (!("agent" in loaded)) return { error: loaded.error };
  const { agent, t, rec, threadId } = loaded;
  if (!(await checkStaffPerm(t, agent, TicketPerm.REFER, tx))) return { error: "denied" };

  const choices = await referralChoices(tx, rec.get("dept_id"), agent, cfg.str("agent_name_format"));
  let evd: Record<string, unknown>;
  let type: ReferralType;
  switch (input.target) {
    case "agent": {
      if (!choices.agents.some((c) => c.id === input.id)) return { error: "unknown_referee" };
      const s = await loadStaffBasic(tx, input.id);
      if (!s) return { error: "unknown_referee" };
      if (!available(s)) return { error: "agent_unavailable" };
      if (rec.get("staff_id") === s.staff_id) return { error: "already_assigned_agent" };
      evd = { staff: [s.staff_id, originalName(s)] };
      type = "S";
      break;
    }
    case "team": {
      if (!choices.teams.some((c) => c.id === input.id)) return { error: "unknown_referee" };
      if (rec.get("team_id") === input.id) return { error: "already_assigned_team" };
      evd = { team: input.id };
      type = "E";
      break;
    }
    case "dept": {
      if (!choices.depts.some((c) => c.id === input.id)) return { error: "unknown_referee" };
      if (rec.get("dept_id") === input.id) return { error: "already_in_dept" };
      evd = { dept: input.id };
      type = "D";
      break;
    }
    default:
      return { error: "unknown_referee" };
  }
  if (!(await threadRefer(tx, threadId, type, input.id))) return { error: "refer_failed" };
  await logTicketEvent(tx, rec.row, threadId, ctx.actor, "referred", evd);
  if (input.comments) await logNote(ctx, rec.id, "Referral", input.comments);
  return { ok: true };
}

/** Referral attivi del thread, per la gestione dalla vista ticket. */
export async function listReferrals(executor: DbOrTx, threadId: number) {
  return executor.selectFrom("thread_referral").select(["id", "object_type", "object_id"]).where("thread_id", "=", threadId).orderBy("id").execute();
}


/**
 * ajax.tickets.php:refer (do=manage): rimozione dei referral selezionati nella scheda "Referral" del
 * modale. Il PHP esegue `$thread->referrals->filter(['id__in' => $remove])->delete()`: DELETE in blocco
 * limitato al thread del ticket, senza eventi né note (TODO "log removal" nel PHP) e senza toccare il
 * ticket. Permessi come il referral: PERM_ASSIGN (endpoint) e PERM_REFER (voce di menu).
 * Restituisce il numero di referral rimossi in `removed`.
 */
export async function removeReferrals(ctx: WriteContext, input: { ticketId: number; ids: number[] }): Promise<ActionResult & { removed?: number }> {
  const loaded = await loadForAction(ctx, input.ticketId, TicketPerm.ASSIGN);
  if (!("agent" in loaded)) return { error: loaded.error };
  const { agent, t, threadId } = loaded;
  if (!(await checkStaffPerm(t, agent, TicketPerm.REFER, ctx.tx))) return { error: "denied" };
  const ids = [...new Set(input.ids.filter((id) => Number.isInteger(id) && id > 0))];
  if (!ids.length || !threadId) return { ok: true, removed: 0 };
  const r = await ctx.tx.deleteFrom("thread_referral").where("thread_id", "=", threadId).where("id", "in", ids).executeTakeFirst();
  return { ok: true, removed: Number(r.numDeletedRows) };
}
