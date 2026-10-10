import "server-only";

import { Team } from "@/lib/osticket/flags";

import { PersonsName } from "../../format/persons-name";
import { loadStaffInfo, staffVar } from "../../mail/objects";
import { VarBag } from "../../mail/variables";
import { TicketPerm } from "../staff/staff";
import { loadForAction } from "./action-load";
import { deptAlertEmail, deptAlertMembers, loadDept, sendStaffAlerts, teamAlertMembers } from "./alerts";
import { activeTeams, assignableAgents, available, deptCanAssignStaff, loadStaffBasic, originalName, type StaffBasic } from "./assignees";
import { agentDisplayName, type WriteContext } from "./context";
import { postNote } from "./post";
import { logTicketEvent } from "./events";
import type { TicketRecord } from "./record";
import { deleteReferralOf, threadRefer, type ReferralType } from "./referral";
import { stateOf } from "./status";
import { checkStaffPerm } from "./ticket";
import { reopenTicket, type ActionResult } from "./ticket-state";

/**
 * Scritture di assegnazione, presa in carico e rilascio di un ticket da parte di un agente
 * (include/class.ticket.php: assign, claim, assignToStaff, assignToTeam, onAssign, release, unassign;
 * include/ajax.tickets.php: assign, claim, release). Assegnatari in assignees.ts, referral in referral.ts.
 */

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
  } else if (!(assignee.flags & Team.NOALERTS)) {
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

interface AssignInput {
  ticketId: number;
  /** "s<id>" agente, "t<id>" team (valori del campo AssigneeField) */
  assignee: string;
  /** mantieni il referral al precedente assegnatario */
  refer?: boolean;
  /** commenti (HTML già sanificato) */
  comments?: string;
  alert?: boolean;
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
    if (!(team.flags & Team.ENABLED)) return { error: "team_disabled" };
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
    if (!(assignee.flags & Team.ENABLED)) return { error: "denied" };
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
