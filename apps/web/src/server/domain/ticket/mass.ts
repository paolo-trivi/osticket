import "server-only";

import { sql } from "kysely";

import { Dept } from "@/lib/osticket/flags";

import { table, type DbOrTx } from "../../db";
import { PersonsName } from "../../format/persons-name";
import { GlobalPerm, TicketPerm, type Agent } from "../staff/staff";
import { ticketThread, ticketThreadId } from "../thread/ids";
import { assignTicket, assignToStaff, deptCanAssignStaff } from "./assign";
import { loadDept, staffSortColumns } from "./alerts";
import type { WriteContext } from "./context";
import { deleteTicket } from "./delete";
import { mergeTypeOf, isParentFlags } from "./merge-flags";
import { logNote } from "./post";
import { TicketRecord } from "./record";
import { isSelectableStatus, loadStatus, setTicketStatus } from "./status";
import { checkStaffPerm, loadTicket } from "./ticket";
import { transferTicket } from "./transfer";

/**
 * Azioni di massa dalla lista dei ticket (include/ajax.tickets.php massProcess e
 * setSelectedTicketsStatus): presa in carico, assegnazione ad agente/team, trasferimento,
 * eliminazione, cambio stato, preparazione di merge/link. Riusa i servizi delle azioni singole.
 * Ogni ticket è verificato a parte (accesso e permesso): quelli non elaborabili vengono saltati,
 * come nel PHP; l'esito riporta quanti ticket sono stati elaborati.
 *
 * Stranezza replicata: per trasferimento e cambio stato il PHP passa lo stesso array `$errors` (per
 * riferimento) a tutti i ticket, e Ticket::transfer e Ticket::setStatus (chiusura) falliscono se
 * contiene già un errore: dopo il primo errore di validazione (ticket già nel reparto, non
 * chiudibile) tutti i ticket successivi falliscono senza scritture. Assegnazione e presa in carico
 * passano invece `$e` per valore a una closure: nessun effetto sui ticket successivi.
 */

export type MassResult = { ok: true; count: number; total: number } | { error: string; detail?: string };

function done(count: number, total: number, failure: string): MassResult {
  return count ? { ok: true, count, total } : { error: failure };
}

/**
 * Agenti proposti dall'assegnazione di massa (massProcess assign/agents): disponibili e visibili
 * (Staff::getDeptAgents); se tutti i reparti dei ticket scelti sono "solo membri"/"solo primari",
 * solo i membri di quei reparti (per l'accesso esteso il PHP esclude solo i reparti "solo primari":
 * `Q::not` con la stessa chiave ripetuta, l'ultima vince).
 */
export async function massAssignableAgents(executor: DbOrTx, agent: Agent, ticketIds: number[], nameFormat: string) {
  const depts = ticketIds.length
    ? (await executor.selectFrom("ticket").select("dept_id").distinct().where("ticket_id", "in", ticketIds).execute()).map((r) => r.dept_id)
    : [];
  let restrictTo: number[] | null = null;
  if (depts.length) {
    const open = await executor
      .selectFrom("department")
      .select("id")
      .where("id", "in", depts)
      .where(sql<boolean>`(flags & ${sql.lit(Dept.ASSIGN_MEMBERS_ONLY)}) = 0`)
      .where(sql<boolean>`(flags & ${sql.lit(Dept.ASSIGN_PRIMARY_ONLY)}) = 0`)
      .execute();
    if (!open.length) restrictTo = depts;
  }
  const visible = !agent.hasGlobalPerm(GlobalPerm.VISIBILITY_AGENTS) && agent.deptIds.length ? [...agent.deptIds] : null;
  const [a, b] = staffSortColumns(nameFormat);
  const { rows } = await sql<{ staff_id: number; firstname: string | null; lastname: string | null }>`
    SELECT DISTINCT S.staff_id, S.firstname, S.lastname, S.${sql.ref(a)}, S.${sql.ref(b)} FROM ${table("staff")} S
    LEFT JOIN ${table("staff_dept_access")} A ON (A.staff_id = S.staff_id)
    LEFT JOIN ${table("department")} AD ON (AD.id = A.dept_id)
    WHERE S.onvacation = 0 AND S.isactive = 1
    ${visible ? sql`AND (S.dept_id IN (${sql.join(visible)}) OR A.dept_id IN (${sql.join(visible)}))` : sql``}
    ${restrictTo ? sql`AND (S.dept_id IN (${sql.join(restrictTo)}) OR (AD.id IN (${sql.join(restrictTo)}) AND (AD.flags & ${sql.lit(Dept.ASSIGN_PRIMARY_ONLY)}) = 0))` : sql``}
    ORDER BY S.${sql.ref(a)}, S.${sql.ref(b)}`.execute(executor);
  return rows.map((r) => ({ id: r.staff_id, name: new PersonsName({ first: r.firstname ?? "", last: r.lastname ?? "" }, nameFormat).toString() }));
}

/** massProcess assign/agents|teams: AssignmentForm validato una volta, poi Ticket::assign per ticket. */
export async function massAssign(ctx: WriteContext, input: { ticketIds: number[]; assignee: string; comments?: string; refer?: boolean }): Promise<MassResult> {
  const { agent } = ctx;
  if (!agent) return { error: "denied" };
  if (!input.ticketIds.length) return { error: "select_tickets" };
  if (input.assignee.startsWith("s")) {
    const choices = await massAssignableAgents(ctx.tx, agent, input.ticketIds, ctx.cfg.str("agent_name_format"));
    if (!choices.some((c) => `s${c.id}` === input.assignee)) return { error: "unknown_assignee" };
  }
  let count = 0;
  for (const ticketId of input.ticketIds) {
    const r = await assignTicket(ctx, { ticketId, assignee: input.assignee, comments: input.comments, refer: input.refer });
    if ("ok" in r) count++;
  }
  return done(count, input.ticketIds.length, "assign_failed");
}

/**
 * massProcess claim: ClaimForm con l'agente stesso, poi Ticket::claim per ogni ticket con
 * ticket.assign. Ticket::claim non controlla che il ticket sia aperto o non assegnato: nella presa in
 * carico di massa un ticket già assegnato passa all'agente (come il PHP).
 */
export async function massClaim(ctx: WriteContext, input: { ticketIds: number[]; comments?: string }): Promise<MassResult> {
  const { tx, agent } = ctx;
  if (!agent) return { error: "denied" };
  if (!input.ticketIds.length) return { error: "select_tickets" };
  let count = 0;
  for (const ticketId of input.ticketIds) {
    const t = await loadTicket(ticketId, agent.id, tx);
    if (!t || !(await checkStaffPerm(t, agent, TicketPerm.ASSIGN, tx))) continue;
    const dept = await loadDept(tx, t.dept_id);
    const staff = { staff_id: agent.id, dept_id: agent.deptId, firstname: agent.name.first, lastname: agent.name.last, isactive: agent.isActive ? 1 : 0, onvacation: agent.onVacation ? 1 : 0 };
    if (!agent.isAvailable || !dept || !(await deptCanAssignStaff(tx, dept, staff))) continue;
    const rec = await TicketRecord.load(tx, ticketId, true);
    if (!rec) continue;
    if (await assignToStaff(ctx, rec, await ticketThreadId(tx, ticketId), agent.id, input.comments ?? "", false)) count++;
  }
  return done(count, input.ticketIds.length, "assign_failed");
}

/** massProcess transfer: TransferForm, poi Ticket::transfer per ogni ticket con ticket.transfer. */
export async function massTransfer(ctx: WriteContext, input: { ticketIds: number[]; deptId: number; comments?: string; refer?: boolean }): Promise<MassResult> {
  if (!ctx.agent) return { error: "denied" };
  if (!input.ticketIds.length) return { error: "select_tickets" };
  let count = 0;
  let failed = false;
  for (const ticketId of input.ticketIds) {
    const t = await loadTicket(ticketId, ctx.agent.id, ctx.tx);
    if (!t || !(await checkStaffPerm(t, ctx.agent, TicketPerm.TRANSFER, ctx.tx)) || failed) continue;
    const r = await transferTicket(ctx, { ticketId, deptId: input.deptId, comments: input.comments, refer: input.refer });
    if ("ok" in r) count++;
    else failed = true;
  }
  return done(count, input.ticketIds.length, "transfer_failed");
}

/** massProcess delete: permesso ticket.delete in almeno un ruolo, poi Ticket::delete($comments) per ticket. */
export async function massDelete(ctx: WriteContext, input: { ticketIds: number[]; comments?: string }): Promise<MassResult> {
  const { tx, agent } = ctx;
  if (!agent) return { error: "denied" };
  if (!agent.hasPermInAnyRole(TicketPerm.DELETE)) return { error: "denied" };
  if (!input.ticketIds.length) return { error: "select_tickets" };
  let count = 0;
  for (const ticketId of input.ticketIds) {
    const t = await loadTicket(ticketId, agent.id, tx);
    if (!t || !(await checkStaffPerm(t, agent, TicketPerm.DELETE, tx))) continue;
    const rec = await TicketRecord.load(tx, ticketId, true);
    if (rec && (await deleteTicket(ctx, rec, input.comments ?? ""))) count++;
  }
  return done(count, input.ticketIds.length, "delete_failed");
}

/**
 * setSelectedTicketsStatus: Staff::canManageTickets, permesso per lo stato in almeno un ruolo
 * (aperto: ticket.close o ticket.create; chiuso: ticket.close; eliminato: ticket.delete), poi per
 * ogni ticket con stato diverso e accessibile Ticket::setStatus($status, $comments) (nota con avvisi,
 * eliminazione definitiva per lo stato "deleted").
 */
export async function massChangeStatus(ctx: WriteContext, input: { ticketIds: number[]; statusId: number; comments?: string }): Promise<MassResult> {
  const { tx, agent } = ctx;
  if (!agent) return { error: "denied" };
  if (!agent.canManageTickets()) return { error: "denied" };
  if (!input.ticketIds.length) return { error: "select_tickets" };
  const status = await loadStatus(tx, input.statusId);
  if (!status) return { error: "invalid_status" };
  // Solo stati del menu (abilitati, open/closed) o l'eliminazione: differenza voluta, vedi isSelectableStatus
  if (status.state.toLowerCase() !== "deleted" && !isSelectableStatus(status)) return { error: "invalid_status" };
  switch (status.state.toLowerCase()) {
    case "open":
      if (!agent.hasPermInAnyRole(TicketPerm.CLOSE) && !agent.hasPermInAnyRole(TicketPerm.CREATE)) return { error: "denied" };
      break;
    case "closed":
      if (!agent.hasPermInAnyRole(TicketPerm.CLOSE)) return { error: "denied" };
      break;
    case "deleted":
      if (!agent.hasPermInAnyRole(TicketPerm.DELETE)) return { error: "denied" };
      break;
    default:
      return { error: "invalid_status" };
  }
  let count = 0;
  let failed = false;
  for (const ticketId of input.ticketIds) {
    const t = await loadTicket(ticketId, agent.id, tx);
    if (!t || t.status_id === status.id || !(await checkStaffPerm(t, agent, undefined, tx))) continue;
    if (failed && status.state === "closed") continue;
    const rec = await TicketRecord.load(tx, ticketId, true);
    if (!rec) continue;
    const thread = await ticketThread(tx, ticketId);
    const r = await setTicketStatus(ctx, rec, thread?.id ?? 0, status.id, {
      comments: input.comments ?? "",
      logNote: (title, body) => logNote(ctx, rec.id, title, body),
      hardDelete: () => deleteTicket(ctx, rec, input.comments ?? ""),
    });
    if (r === true) count++;
    else if (typeof r === "string") failed = true;
  }
  return done(count, input.ticketIds.length, "status_failed");
}

/**
 * massProcess merge|link (GET): controlli sui ticket scelti e ordine proposto nel dialogo (il padre
 * di un merge esistente in cima). Errori come il PHP: ticket già uniti non collegabili, più padri
 * di merge, figli di merge non unibili, permesso mancante su un ticket.
 */
export async function massMergeCandidates(
  executor: DbOrTx,
  agent: Agent,
  ticketIds: number[],
  title: "merge" | "link",
): Promise<{ error: string } | { tickets: { id: number; number: string; subject: string }[] }> {
  const perm = title === "link" ? TicketPerm.LINK : TicketPerm.MERGE;
  const rows = ticketIds.length
    ? await executor
        .selectFrom("ticket as t")
        .leftJoin("ticket__cdata as c", "c.ticket_id", "t.ticket_id")
        .select(["t.ticket_id", "t.number", "t.flags", "t.dept_id", "t.ticket_pid", "c.subject"])
        .where("t.ticket_id", "in", ticketIds)
        .execute()
    : [];
  let error: string | null = null;
  let parentId: number | null = null;
  for (const r of rows) {
    const type = mergeTypeOf(r.flags);
    const isParent = isParentFlags(r.flags);
    if (!agent.roleFor(r.dept_id).perms.has(perm)) error ??= "denied";
    if (!parentId && isParent && type !== "visual") parentId = r.ticket_id;
    if (type !== "visual" && title === "link") error = "merged_cannot_link";
    if (parentId && isParent && type !== "visual" && parentId !== r.ticket_id) error = "multiple_parents";
    if (r.ticket_pid && type !== "visual" && title === "merge") error = "merged_child";
  }
  for (const id of ticketIds) {
    const t = await loadTicket(id, agent.id, executor);
    if (!t || !(await checkStaffPerm(t, agent, undefined, executor))) error ??= "denied";
  }
  if (error) return { error };
  // FIELD(ticket_id, ...) con il padre in testa, altrimenti per `sort`
  const order = ticketIds.length > 1 ? (parentId ? [parentId, ...ticketIds.filter((i) => i !== parentId)] : ticketIds) : null;
  const sorted = order
    ? order.map((id) => rows.find((r) => r.ticket_id === id)).filter((r): r is (typeof rows)[number] => !!r)
    : rows;
  return { tickets: sorted.map((r) => ({ id: r.ticket_id, number: r.number ?? "", subject: r.subject ?? "" })) };
}
