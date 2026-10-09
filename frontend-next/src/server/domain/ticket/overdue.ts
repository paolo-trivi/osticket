import "server-only";

import { NOW, type DbOrTx } from "../../db";
import { GlobalPerm } from "../staff/staff";
import { createThreadEntry } from "../thread/write";
import { deptAlertEmail, deptAlertMembers, loadDept, sendStaffAlerts, teamAlertMembers } from "./alerts";
import { agentDisplayName, type WriteContext } from "./context";
import type { EditResult } from "./edit";
import { logTicketEvent } from "./events";
import { ticketThread } from "./merge-flags";
import { TicketRecord } from "./record";
import { stateOf } from "./status";
import { checkStaffPerm, loadTicket } from "./ticket";

/**
 * Voci "Segna come scaduto" e "Ban/Unban email" del menu "Altro" della vista ticket
 * (scp/tickets.php a=process do=overdue|banemail|unbanemail).
 */

/** Sla::FLAG_NOALERTS */
const SLA_NOALERTS = 0x0004;

/**
 * Ticket::onOverdue($whine): avviso "ticket.overdue" all'assegnatario (agente o membri del team) se
 * overdue_alert_assigned, altrimenti ai membri del reparto (overdue_alert_dept_members, solo se il
 * ticket non è assegnato), più il manager del reparto (overdue_alert_dept_manager). L'agente che
 * segna il ticket non è escluso (come il PHP).
 */
async function onOverdue(ctx: WriteContext, rec: TicketRecord, comments = ""): Promise<void> {
  const { tx, cfg } = ctx;
  if (rec.get("sla_id")) {
    const sla = await tx.selectFrom("sla").select("flags").where("id", "=", rec.get("sla_id")).executeTakeFirst();
    if (sla && sla.flags & SLA_NOALERTS) return;
  }
  if (!cfg.bool("overdue_alert_active")) return;
  const dept = await loadDept(tx, rec.get("dept_id"));
  if (!dept) return;
  const nameFormat = cfg.str("agent_name_format");
  const members = await deptAlertMembers(tx, dept, nameFormat);
  if (!members.length) return;
  const email = await deptAlertEmail(ctx, dept);
  if (!email) return;

  const recipients: number[] = [];
  const assigned = (await stateOf(tx, rec.row)) === "open" && !!(rec.get("staff_id") || rec.get("team_id"));
  if (assigned && cfg.bool("overdue_alert_assigned")) {
    if (rec.get("staff_id")) recipients.push(rec.get("staff_id"));
    else if (rec.get("team_id")) {
      const team = await tx.selectFrom("team").select("team_id").where("team_id", "=", rec.get("team_id")).executeTakeFirst();
      if (team) recipients.push(...(await teamAlertMembers(tx, team.team_id)));
    }
  } else if (cfg.bool("overdue_alert_dept_members") && !assigned) {
    recipients.push(...members);
  }
  if (cfg.bool("overdue_alert_dept_manager") && dept.manager_id) recipients.push(dept.manager_id);

  await sendStaffAlerts(ctx, { ticketId: rec.id, deptId: dept.id, code: "ticket.overdue", email, vars: { comments }, recipients });
}

/**
 * scp/tickets.php do=overdue: solo il manager del reparto del ticket; Ticket::markOverdue (solo
 * ticket aperti; isoverdue = 1, evento "overdue", avvisi), poi nota di sistema
 * "Ticket Marked Overdue" (logActivity, senza avvisi).
 */
export async function markTicketOverdue(ctx: WriteContext, input: { ticketId: number }): Promise<EditResult> {
  const { tx, agent, cfg } = ctx;
  if (!agent) return { error: "denied" };
  const t = await loadTicket(input.ticketId, agent.id, tx);
  if (!t || !(await checkStaffPerm(t, agent, undefined, tx))) return { error: "not_found" };
  const dept = await loadDept(tx, t.dept_id);
  if (!dept || dept.manager_id !== agent.id) return { error: "denied" };
  const rec = await TicketRecord.load(tx, input.ticketId, true);
  if (!rec) return { error: "not_found" };
  if ((await stateOf(tx, rec.row)) !== "open") return { error: "not_open" };
  const thread = await ticketThread(tx, rec.id);
  if (!rec.get("isoverdue")) {
    rec.set("isoverdue", 1);
    await rec.save();
    if (thread) await logTicketEvent(tx, rec.row, thread.id, ctx.actor, "overdue");
    await onOverdue(ctx, rec);
  }
  // logActivity → logNote($title, $msg, 'SYSTEM', false)
  if (thread) {
    await createThreadEntry(tx, cfg, {
      threadId: thread.id,
      type: "N",
      body: `Ticket flagged as overdue by ${agentDisplayName(agent, cfg)}`,
      format: "html",
      title: "Ticket Marked Overdue",
      staffId: 0,
      userId: 0,
      poster: "SYSTEM",
      ip: ctx.actor?.ip ?? "",
    });
  }
  return { ok: true };
}

/** Indirizzo email del proprietario del ticket (Ticket::getEmail). */
async function ownerEmail(tx: DbOrTx, userId: number): Promise<string> {
  const r = await tx
    .selectFrom("user as u")
    .innerJoin("user_email as e", "e.id", "u.default_email_id")
    .select("e.address")
    .where("u.id", "=", userId)
    .executeTakeFirst();
  return r?.address ?? "";
}

/** Filtro "SYSTEM BAN LIST" (Banlist::getSystemBanList). */
async function banListId(tx: DbOrTx): Promise<number | null> {
  const f = await tx.selectFrom("filter").select("id").where("name", "=", "SYSTEM BAN LIST").orderBy("id").executeTakeFirst();
  return f?.id ?? null;
}

/** Il PHP crea il filtro della ban list se manca (Banlist::createSystemBanList): qui si segnala l'errore. */
export async function emailInBanList(tx: DbOrTx, address: string): Promise<boolean> {
  const id = await banListId(tx);
  if (!id || !address) return false;
  const r = await tx
    .selectFrom("filter_rule")
    .select("id")
    .where("filter_id", "=", id)
    .where("what", "=", "email")
    .where("how", "=", "equal")
    .where("val", "=", address)
    .executeTakeFirst();
  return !!r;
}

/**
 * scp/tickets.php do=banemail / unbanemail (permesso emails.banlist): Banlist::add inserisce una
 * regola `email equal <indirizzo>` nel filtro "SYSTEM BAN LIST"; Banlist::remove cancella le regole
 * corrispondenti. Rimuovere un indirizzo non presente restituisce `not_banned` (avviso nel PHP).
 */
export async function setTicketEmailBan(ctx: WriteContext, input: { ticketId: number; ban: boolean }): Promise<EditResult & { email?: string }> {
  const { tx, agent } = ctx;
  if (!agent) return { error: "denied" };
  const t = await loadTicket(input.ticketId, agent.id, tx);
  if (!t || !(await checkStaffPerm(t, agent, undefined, tx))) return { error: "not_found" };
  if (!agent.hasGlobalPerm(GlobalPerm.BANLIST)) return { error: "denied" };
  const address = await ownerEmail(tx, t.user_id);
  const filterId = await banListId(tx);
  if (!filterId) return { error: "no_banlist" };
  if (input.ban) {
    if (await emailInBanList(tx, address)) return { error: "already_banned" };
    await tx
      .insertInto("filter_rule")
      .values({ filter_id: filterId, what: "email", how: "equal", val: address, isactive: 1, notes: "", created: NOW, updated: NOW })
      .execute();
    return { ok: true, email: address };
  }
  const res = await tx
    .deleteFrom("filter_rule")
    .where("filter_id", "=", filterId)
    .where("what", "=", "email")
    .where("how", "=", "equal")
    .where("val", "=", address)
    .executeTakeFirst();
  if (Number(res.numDeletedRows ?? 0)) return { ok: true, email: address };
  return { error: "not_banned" };
}
