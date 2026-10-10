import "server-only";

import { ObjectType } from "@/lib/osticket/object-types";

import { NOW, type DbOrTx } from "../../db";
import { PersonsName } from "../../format/persons-name";
import { TicketPerm, type Agent } from "../staff/staff";
import { loadForAction } from "./action-load";
import { staffSortColumns } from "./alerts";
import { activeTeams, available, loadStaffBasic, originalName, selectableDepts } from "./assignees";
import type { WriteContext } from "./context";
import { logTicketEvent } from "./events";
import { logNote } from "./post";
import { checkStaffPerm } from "./ticket";
import type { ActionResult } from "./ticket-state";

/**
 * Referral di un ticket (include/class.thread.php Thread::refer, include/class.ticket.php Ticket::refer,
 * include/ajax.tickets.php refer): inoltro a reparto, team o agente, scelte del form, elenco e rimozione.
 */

/** ObjectModel::OBJECT_TYPE_* usati da thread_referral */
export type ReferralType = typeof ObjectType.STAFF | typeof ObjectType.TEAM | typeof ObjectType.DEPT;

// --- Referral (Thread::refer / getReferral) ---------------------------------------------

async function findReferral(executor: DbOrTx, threadId: number, type: ReferralType, objectId: number) {
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
