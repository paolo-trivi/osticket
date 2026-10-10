import "server-only";

import { Dept, Team } from "@/lib/osticket/flags";
import { ObjectType } from "@/lib/osticket/object-types";

import { loadAgent } from "../staff/staff";
import { agentDisplayName, type WriteContext } from "./context";
import { onAssignAlert } from "./create-alerts";
import { logTicketEvent } from "./events";
import { postNote } from "./post";
import type { TicketRecord } from "./record";
import { stateOf } from "./status";

/**
 * Assegnazione durante la creazione del ticket (include/class.ticket.php): auto-assegnazione da topic,
 * filtri e organizzazione (Ticket::assignToStaff/assignToTeam) e assegnazione dal form di apertura dell'agente
 * (assign con AssignmentForm). Gli avvisi passano da onAssignAlert (create-alerts.ts); le azioni di
 * assegnazione sui ticket esistenti sono in assign.ts.
 */

/** Ticket::assignToStaff (auto-assegnazione di topic/filtri/organizzazione) */
export async function autoAssignToStaff(ctx: WriteContext, rec: TicketRecord, threadId: number, staffId: number, alert: boolean, who: string): Promise<boolean> {
  const staff = await loadAgent(staffId, ctx.tx);
  if (!staff || !staff.isAvailable) return false;
  rec.set("staff_id", staff.id);
  await rec.save();
  if (alert) await onAssignAlert(ctx, { ticketId: rec.id, deptId: rec.get("dept_id") }, { kind: "staff", id: staff.id }, "", null);
  const data = ctx.agent && ctx.agent.id === staff.id ? { claim: true } : { staff: staff.id };
  await logTicketEvent(ctx.tx, rec.row, threadId, ctx.actor, "assigned", data, who);
  await ctx.tx.deleteFrom("thread_referral").where("thread_id", "=", threadId).where("object_type", "=", ObjectType.STAFF).where("object_id", "=", staff.id).execute();
  return true;
}

/** Ticket::assignToTeam */
export async function autoAssignToTeam(ctx: WriteContext, rec: TicketRecord, threadId: number, teamId: number, alert: boolean, who: string): Promise<boolean> {
  const team = await ctx.tx.selectFrom("team").select(["team_id", "flags"]).where("team_id", "=", teamId).executeTakeFirst();
  if (!team || !(team.flags & Team.ENABLED)) return false;
  rec.set("team_id", team.team_id);
  await rec.save();
  if ((await stateOf(ctx.tx, rec.row)) === "closed") {
    rec.set("staff_id", 0);
    await rec.save();
  }
  if (alert) await onAssignAlert(ctx, { ticketId: rec.id, deptId: rec.get("dept_id") }, { kind: "team", id: team.team_id }, "", null);
  await logTicketEvent(ctx.tx, rec.row, threadId, ctx.actor, "assigned", { team: team.team_id }, who);
  await ctx.tx.deleteFrom("thread_referral").where("thread_id", "=", threadId).where("object_type", "=", ObjectType.TEAM).where("object_id", "=", team.team_id).execute();
  return true;
}

/** Dept::canAssign per un agente */
async function deptCanAssignStaff(ctx: WriteContext, deptId: number, staffId: number): Promise<boolean> {
  const d = await ctx.tx.selectFrom("department").select(["id", "flags", "manager_id"]).where("id", "=", deptId).executeTakeFirst();
  const staff = await loadAgent(staffId, ctx.tx);
  if (!d || !staff) return false;
  if (d.flags & Dept.ASSIGN_PRIMARY_ONLY && staff.deptId !== d.id) return false;
  if (d.flags & Dept.ASSIGN_MEMBERS_ONLY) {
    const member = staff.deptId === d.id || d.manager_id === staff.id || staff.extendedAccess.some((a) => a.deptId === d.id);
    if (!member) return false;
  }
  return staff.isAvailable;
}

/**
 * Ticket::assign(AssignmentForm) dall'apertura da agente (`assignId` = s<id> | t<id>, commenti = nota).
 */
export async function assignFromForm(ctx: WriteContext, rec: TicketRecord, threadId: number, assignId: string, comments: string): Promise<string | true> {
  const kind = assignId[0];
  const id = Number(assignId.slice(1));
  let alert = true;
  let evd: Record<string, unknown>;
  let assignee: { kind: "staff"; id: number } | { kind: "team"; id: number };
  let assigneeName: string;
  if (kind === "s") {
    const staff = await loadAgent(id, ctx.tx);
    if (!staff) return "Unknown assignee";
    if (rec.get("staff_id") === staff.id) return "Ticket already assigned to the agent";
    if (!staff.isAvailable) return "Agent is unavailable for assignment";
    if (!(await deptCanAssignStaff(ctx, rec.get("dept_id"), staff.id))) return "Permission denied";
    rec.set("staff_id", staff.id);
    if (ctx.agent && ctx.agent.id === staff.id) {
      alert = false;
      evd = { claim: true };
    } else evd = { staff: [staff.id, staff.name.full] };
    assignee = { kind: "staff", id: staff.id };
    assigneeName = agentDisplayName(staff, ctx.cfg);
    await ctx.tx.deleteFrom("thread_referral").where("thread_id", "=", threadId).where("object_type", "=", ObjectType.STAFF).where("object_id", "=", staff.id).execute();
  } else if (kind === "t") {
    const team = await ctx.tx.selectFrom("team").select(["team_id", "name", "flags"]).where("team_id", "=", id).executeTakeFirst();
    if (!team) return "Unknown assignee";
    if (rec.get("team_id") === team.team_id) return "Ticket already assigned to the team";
    const members = await ctx.tx.selectFrom("team_member").select("staff_id").where("team_id", "=", team.team_id).execute();
    if (!(team.flags & Team.ENABLED) || !members.length) return "Permission denied";
    rec.set("team_id", team.team_id);
    evd = { team: team.team_id };
    assignee = { kind: "team", id: team.team_id };
    assigneeName = team.name;
    await ctx.tx.deleteFrom("thread_referral").where("thread_id", "=", threadId).where("object_type", "=", ObjectType.TEAM).where("object_id", "=", team.team_id).execute();
  } else return "Unknown assignee";
  await rec.save(true);
  await logTicketEvent(ctx.tx, rec.row, threadId, ctx.actor, "assigned", evd);
  // onAssign: nota con i commenti (senza avvisi) e avviso assigned.alert
  let note: { id: number; threadId: number } | null = null;
  if (comments) {
    const title =
      assignee.kind === "staff" && ctx.agent && assignee.id === ctx.agent.id
        ? `Ticket claimed by ${agentDisplayName(ctx.agent, ctx.cfg)}`
        : `Ticket Assigned to ${assigneeName}`;
    const r = await postNote(ctx, { ticketId: rec.id, note: comments, title, format: "html", alert: false });
    if ("entryId" in r) note = { id: r.entryId, threadId };
    await rec.reload();
  }
  if (alert) await onAssignAlert(ctx, { ticketId: rec.id, deptId: rec.get("dept_id") }, assignee, comments, note);
  return true;
}
