import "server-only";

import { loadStaffInfo, staffVar, entryVar } from "../../mail/objects";
import { TicketPerm } from "../staff/staff";
import { deptAlertEmail, deptAlertMembers, deptIsMember, loadDept, sendStaffAlerts, teamAlertMembers } from "./alerts";
import { deleteReferralOf, selectableDepts, threadRefer } from "./assign";
import type { WriteContext } from "./context";
import { logTicketEvent } from "./events";
import { postNote, ticketThreadId } from "./post";
import { TicketRecord } from "./record";
import { DeptFlag, stateOf } from "./status";
import { checkStaffPerm, loadTicket } from "./ticket";
import { reopenTicket, type ActionResult } from "./ticket-state";

/** SLA::FLAG_TRANSIENT */
const SLA_TRANSIENT = 0x0008;

interface TransferInput {
  ticketId: number;
  deptId: number;
  /** mantieni il referral al reparto attuale */
  refer?: boolean;
  /** commenti (HTML già sanificato) */
  comments?: string;
  alert?: boolean;
}

/**
 * ajax.tickets.php:transfer → TransferForm → Ticket::transfer (include/class.ticket.php:2655):
 * - nuovo reparto; agente azzerato se il reparto assegna solo ai membri e l'agente non lo è;
 * - riapertura se chiuso (Ticket::reopen, che ricalcola la scadenza SLA con lo SLA ancora attuale);
 * - SLA del nuovo reparto se il ticket non ne ha uno o il suo è "transient" (solo sla_id: il PHP non
 *   ricalcola est_duedate qui);
 * - evento 'transferred' {"dept": nome}, cancellazione del referral al nuovo reparto, nota con i
 *   commenti, referral al reparto precedente se richiesto, avvisi 'transfer.alert'.
 */
export async function transferTicket(ctx: WriteContext, input: TransferInput): Promise<ActionResult> {
  const { tx, cfg, agent } = ctx;
  if (!agent) return { error: "denied" };
  const t = await loadTicket(input.ticketId, agent.id, tx);
  if (!t) return { error: "not_found" };
  if (!(await checkStaffPerm(t, agent, TicketPerm.TRANSFER, tx))) return { error: "denied" };
  const rec = await TicketRecord.load(tx, input.ticketId, true);
  if (!rec) return { error: "not_found" };
  const threadId = await ticketThreadId(tx, rec.id);

  // TransferForm: reparto tra quelli proposti
  const choices = await selectableDepts(tx, agent, rec.get("dept_id"));
  if (!input.deptId || !choices.some((d) => d.id === input.deptId)) return { error: "dept_required" };
  const dept = await loadDept(tx, input.deptId);
  if (!dept) return { error: "dept_required" };
  if (dept.id === rec.get("dept_id")) return { error: "already_in_dept" };
  const cdept = await loadDept(tx, rec.get("dept_id"));

  rec.set("dept_id", dept.id);
  const state = await stateOf(tx, rec.row);
  const assigned = state === "open" && !!(rec.get("staff_id") || rec.get("team_id"));
  if (assigned && rec.get("staff_id") && dept.flags & DeptFlag.ASSIGN_MEMBERS_ONLY) {
    const staff = await tx.selectFrom("staff").select("staff_id").where("staff_id", "=", rec.get("staff_id")).executeTakeFirst();
    if (staff && !(await deptIsMember(tx, dept, staff.staff_id))) rec.set("staff_id", 0);
  }
  await rec.save(true);

  if ((await stateOf(tx, rec.row)) === "closed") await reopenTicket(ctx, rec, threadId);

  // SLA del nuovo reparto
  const sla = rec.get("sla_id") ? await tx.selectFrom("sla").select(["id", "flags"]).where("id", "=", rec.get("sla_id")).executeTakeFirst() : undefined;
  if (!rec.get("sla_id") || (sla && sla.flags & SLA_TRANSIENT)) {
    if (dept.sla_id && dept.sla_id !== rec.get("sla_id")) {
      // selectSLAId($trump) → setSLAId: lo SLA deve esistere
      const exists = await tx.selectFrom("sla").select("id").where("id", "=", dept.sla_id).executeTakeFirst();
      if (exists) {
        rec.set("sla_id", dept.sla_id);
        await rec.save();
      }
    }
  }

  await logTicketEvent(tx, rec.row, threadId, ctx.actor, "transferred", { dept: dept.name });
  await deleteReferralOf(tx, threadId, "D", dept.id);

  let note: { entryId: number } | null = null;
  if (input.comments) {
    const title = `Ticket transferred from ${cdept?.name ?? ""} to ${dept.name}`;
    const r = await postNote(ctx, { ticketId: rec.id, note: input.comments, title, alert: false });
    if ("entryId" in r) note = r;
  }
  if (input.refer && cdept) await threadRefer(tx, threadId, "D", cdept.id);

  // Avvisi
  const nameFormat = cfg.str("agent_name_format");
  if (!(input.alert ?? true) || !cfg.bool("transfer_alert_active") || !(await deptAlertMembers(tx, dept, nameFormat)).length) return { ok: true };
  const email = await deptAlertEmail(ctx, dept);
  if (!email) return { ok: true };

  const recipients: number[] = [];
  const nowAssigned = (await stateOf(tx, rec.row)) === "open" && !!(rec.get("staff_id") || rec.get("team_id"));
  if (nowAssigned && cfg.bool("transfer_alert_assigned")) {
    if (rec.get("staff_id")) recipients.push(rec.get("staff_id"));
    else if (rec.get("team_id")) recipients.push(...(await teamAlertMembers(tx, rec.get("team_id"))));
  } else if (cfg.bool("transfer_alert_dept_members") && !nowAssigned) {
    recipients.push(...(await deptAlertMembers(tx, dept, nameFormat)));
  }
  if (cfg.bool("transfer_alert_dept_manager") && dept.manager_id) recipients.push(dept.manager_id);

  const me = await loadStaffInfo(tx, agent.id);
  const staffV = me ? staffVar(me, cfg) : null;
  let comments: unknown = "";
  if (note) {
    const row = await tx.selectFrom("thread_entry").selectAll().where("id", "=", note.entryId).executeTakeFirstOrThrow();
    comments = entryVar(row, cfg, ctx.dbZone, staffV);
  }
  await sendStaffAlerts(ctx, {
    ticketId: rec.id,
    deptId: dept.id,
    code: "transfer.alert",
    email,
    vars: { comments, staff: staffV },
    recipients,
    thread: note ? { entryId: note.entryId, threadId } : null,
  });
  return { ok: true };
}
