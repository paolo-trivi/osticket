import "server-only";

import { phpJsonDecode } from "../../format/php-json";
import { createThreadEntry } from "../thread/write";
import { agentDisplayName, type WriteContext } from "./context";
import { logNote, postNote, ticketThreadId } from "./post";
import { TicketRecord } from "./record";
import { loadStatus, roleOnRow, setTicketStatus, statusIsReopenable, stateOf, type StatusRow } from "./status";
import { checkStaffPerm, loadTicket } from "./ticket";
import { TicketPerm } from "../staff/staff";

/**
 * Cambio stato da menu, riapertura e "segna come risposto/non risposto" (include/ajax.tickets.php
 * setTicketStatus/markAs, Ticket::reopen, Ticket::markAnswered/markUnAnswered).
 */

/** Ticket::FLAG_PARENT */
const TICKET_FLAG_PARENT = 0x0010;

export type ActionResult = { ok: true; warn?: string } | { error: string; detail?: string };

/** TicketStatus::getReopenStatus(): stato di riapertura configurato, solo se di stato "open". */
async function reopenStatusOf(ctx: WriteContext, status: StatusRow): Promise<StatusRow | null> {
  if (!statusIsReopenable(status)) return null;
  const conf = phpJsonDecode<Record<string, unknown>>(status.properties, {});
  if (!("reopenstatus" in conf)) return null;
  const s = await loadStatus(ctx.tx, Number(conf.reopenstatus) || ctx.cfg.int("default_ticket_status_id", 1));
  return s && s.state.toLowerCase() === "open" ? s : null;
}

/** Ticket::reopen(): solo ticket chiusi; stato di riapertura o stato predefinito. */
export async function reopenTicket(ctx: WriteContext, rec: TicketRecord, threadId: number): Promise<true | false | string> {
  const current = await loadStatus(ctx.tx, rec.get("status_id"));
  if (!current || current.state !== "closed") return false;
  const target = (await reopenStatusOf(ctx, current))?.id ?? ctx.cfg.int("default_ticket_status_id", 1);
  if (!target) return false;
  return setTicketStatus(ctx, rec, threadId, target, { logNote: (t, b) => logNote(ctx, rec.id, t, b) });
}

/** Stati proposti dal menu "Cambia stato" (status-options.tmpl.php): abilitati, open/closed, diversi dall'attuale. */
export async function menuStatuses(ctx: Pick<WriteContext, "tx">, currentStatusId: number): Promise<{ id: number; name: string; state: string }[]> {
  const rows = await ctx.tx
    .selectFrom("ticket_status")
    .select(["id", "name", "state", "mode"])
    .where("state", "in", ["open", "closed"])
    .orderBy("sort")
    .orderBy("name")
    .execute();
  // TicketStatus::ENABLED = 1 (mode); isCloseable() restituisce true o una stringa: "closed" è sempre incluso
  return rows.filter((r) => r.mode & 1 && r.id !== currentStatusId).map((r) => ({ id: r.id, name: r.name, state: r.state ?? "" }));
}

/**
 * ajax.tickets.php:setTicketStatus: controlli di permesso per stato, Ticket::setStatus con commenti
 * (nota "Status Changed" con avvisi), poi eventualmente lo stesso stato ai ticket figli.
 * Lo stato "deleted" (eliminazione definitiva) non è gestito qui.
 */
export async function changeTicketStatus(
  ctx: WriteContext,
  input: { ticketId: number; statusId: number; comments?: string; children?: boolean },
): Promise<ActionResult> {
  const { tx, agent } = ctx;
  if (!agent) return { error: "denied" };
  const t = await loadTicket(input.ticketId, agent.id, tx);
  if (!t || !(await checkStaffPerm(t, agent, undefined, tx))) return { error: "not_found" };
  const rec = await TicketRecord.load(tx, input.ticketId, true);
  if (!rec) return { error: "not_found" };
  const status = input.statusId ? await loadStatus(tx, input.statusId) : null;
  if (!status) return { error: "invalid_status" };
  if (status.id === rec.get("status_id")) return { error: "already_status" };
  const role = roleOnRow(rec.row, await stateOf(tx, rec.row), agent);
  switch (status.state.toLowerCase()) {
    case "open":
      if (!role.perms.has(TicketPerm.CLOSE) && !role.perms.has(TicketPerm.CREATE)) return { error: "denied" };
      break;
    case "closed":
      if (!role.perms.has(TicketPerm.CLOSE)) return { error: "denied" };
      break;
    case "deleted":
      // Eliminazione definitiva: area "ticketedit"
      return { error: "not_supported" };
    default:
      return { error: "invalid_status" };
  }

  const threadId = await ticketThreadId(tx, rec.id);
  const r = await setTicketStatus(ctx, rec, threadId, status.id, {
    comments: input.comments ?? "",
    logNote: (title, body) => logNote(ctx, rec.id, title, body),
  });
  if (r !== true) return { error: "status_failed", detail: typeof r === "string" ? r : undefined };

  const failures: string[] = [];
  // Ticket::getChildren(): solo per i ticket padre (FLAG_PARENT), figli con ticket_pid = id ordinati per sort
  if (input.children && rec.get("flags") & TICKET_FLAG_PARENT) {
    const children = await tx
      .selectFrom("ticket")
      .select(["ticket_id", "number"])
      .where("ticket_pid", "=", rec.id)
      .orderBy("sort")
      .orderBy("ticket_id")
      .execute();
    for (const c of children) {
      const child = await TicketRecord.load(tx, c.ticket_id, true);
      if (!child) continue;
      const childThread = await ticketThreadId(tx, child.id);
      const cr = await setTicketStatus(ctx, child, childThread, status.id, { logNote: (title, body) => logNote(ctx, child.id, title, body) });
      if (cr !== true) failures.push(c.number ?? String(c.ticket_id));
    }
  }
  return failures.length ? { ok: true, warn: failures.join(", ") } : { ok: true };
}

/**
 * ajax.tickets.php:markAs: segna come risposto/non risposto (isanswered + updated), nota opzionale
 * con i commenti (titolo "Ticket Marked Answered"), poi nota di sistema Ticket::logActivity.
 * Nessun evento thread_event (il PHP non ne registra).
 */
export async function markTicketAnswered(
  ctx: WriteContext,
  input: { ticketId: number; answered: boolean; comments?: string },
): Promise<ActionResult> {
  const { tx, agent, cfg } = ctx;
  if (!agent) return { error: "denied" };
  const t = await loadTicket(input.ticketId, agent.id, tx);
  if (!t) return { error: "not_found" };
  const dept = await tx.selectFrom("department").select("manager_id").where("id", "=", t.dept_id).executeTakeFirst();
  const isManager = !!dept?.manager_id && dept.manager_id === agent.id;
  if (!(await checkStaffPerm(t, agent, TicketPerm.MARKANSWERED, tx)) && !isManager) return { error: "denied" };

  const rec = await TicketRecord.load(tx, input.ticketId, true);
  if (!rec) return { error: "not_found" };
  const action = input.answered ? "answered" : "unanswered";
  if (input.answered) {
    if (rec.get("isanswered")) return { error: "already_answered" };
  } else if (!rec.get("isanswered")) return { error: "already_unanswered" };
  // setAnsweredState
  rec.set("isanswered", input.answered ? 1 : 0);
  await rec.save();

  const title = `Ticket Marked ${action.charAt(0).toUpperCase()}${action.slice(1)}`;
  if (input.comments) await postNote(ctx, { ticketId: rec.id, note: input.comments, title, alert: false });

  // logActivity → logNote($title, $msg, 'SYSTEM', false): nota senza autore (poster SYSTEM)
  const threadId = await ticketThreadId(tx, rec.id);
  await createThreadEntry(tx, cfg, {
    threadId,
    type: "N",
    body: `Ticket flagged as ${action} by ${agentDisplayName(agent, cfg)}`,
    format: "html",
    title,
    staffId: 0,
    userId: 0,
    poster: "SYSTEM",
    ip: ctx.actor?.ip ?? "",
  });
  return { ok: true };
}
