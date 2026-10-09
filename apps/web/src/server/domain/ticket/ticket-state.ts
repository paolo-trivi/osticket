import "server-only";

import { sql } from "kysely";

import type { ConfigNamespace } from "../../config/config";
import type { DbOrTx } from "../../db";
import { phpJsonDecode } from "../../format/php-json";
import { createThreadEntry } from "../thread/write";
import { agentDisplayName, type WriteContext } from "./context";
import { logNote, postNote, ticketThreadId } from "./post";
import { TicketRecord } from "./record";
import { isCloseable, isSelectableStatus, loadStatus, roleOnRow, setTicketStatus, statusIsReopenable, stateOf, type StatusRow } from "./status";
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

interface StatusChoice {
  id: number;
  name: string;
  state: string;
}

/**
 * Stati "open" e "closed" abilitati (TicketStatusList::getStatuses con states open/closed), nell'ordine
 * della lista (sort_mode: SortCol → sort, Alpha → nome, -Alpha → nome decrescente). Il menu
 * (status-options.tmpl.php) esclude lo stato attuale; il modale (ticket-status.tmpl.php) propone tutti
 * gli stati dello stesso "state", attuale compreso. "closed" è sempre incluso: Ticket::isCloseable()
 * restituisce true oppure una stringa (sempre "vera").
 */
export async function ticketStatusChoices(executor: DbOrTx): Promise<StatusChoice[]> {
  const list = await executor.selectFrom("list").select("sort_mode").where("type", "=", "ticket-status").executeTakeFirst();
  let q = executor
    .selectFrom("ticket_status")
    .select(["id", "name", "state", "mode"])
    .where("state", "in", ["open", "closed"])
    // TicketStatus::ENABLED = 1 (mode__hasbit)
    .where(sql<boolean>`(mode & 1) != 0`);
  switch (list?.sort_mode) {
    case "SortCol":
      q = q.orderBy("sort");
      break;
    case "Alpha":
      q = q.orderBy("name");
      break;
    case "-Alpha":
      q = q.orderBy("name", "desc");
      break;
  }
  const rows = await q.execute();
  return rows.map((r) => ({ id: r.id, name: r.name, state: r.state ?? "" }));
}

/** Motivo per cui il ticket non è chiudibile (Ticket::isCloseable), per l'avviso del modale di chiusura. */
type CloseBlocker = { reason: "fields" } | { reason: "tasks"; count: number } | { reason: "topic" };

/**
 * ajax.tickets.php:changeTicketStatus('close'): se Ticket::isCloseable() restituisce una stringa, il
 * modale la mostra come avviso (la chiusura poi fallisce in Ticket::setStatus). Sola lettura.
 */
export async function closeBlocker(executor: DbOrTx, cfg: ConfigNamespace, ticketId: number): Promise<CloseBlocker | null> {
  const rec = await TicketRecord.load(executor, ticketId);
  if (!rec) return null;
  // isCloseable usa solo tx e cfg del contesto
  const ro = { tx: executor, cfg } as Pick<WriteContext, "tx" | "cfg"> as WriteContext;
  const r = await isCloseable(ro, rec, await stateOf(executor, rec.row));
  if (r === true) return null;
  const tasks = /has (\d+) open tasks/.exec(r);
  if (tasks) return { reason: "tasks", count: Number(tasks[1]) };
  return /Help Topic/.test(r) ? { reason: "topic" } : { reason: "fields" };
}

/**
 * Aggancio per lo stato "deleted" (Ticket::setStatus → Ticket::delete($comments)): l'eliminazione
 * definitiva appartiene all'area "ticketedit", che fornisce questa funzione a changeTicketStatus.
 * Restituisce true se il ticket è stato eliminato.
 */
export type TicketHardDelete = (ctx: WriteContext, rec: TicketRecord, comments: string) => Promise<boolean>;

/**
 * ajax.tickets.php:setTicketStatus: controlli di permesso per stato, Ticket::setStatus con commenti
 * (nota "Status Changed" con avvisi), poi eventualmente lo stesso stato ai ticket figli.
 * Lo stato "deleted" richiede PERM_DELETE e l'aggancio opts.hardDelete (area "ticketedit"): senza,
 * l'operazione è rifiutata con "not_supported".
 * Il PHP, con figli non aggiornabili, prepara l'avviso in $info['warn'] ma risponde comunque 201 e
 * l'avviso va perso: qui i numeri dei figli sono restituiti in `warn` e mostrati dalla UI.
 */
export async function changeTicketStatus(
  ctx: WriteContext,
  input: { ticketId: number; statusId: number; comments?: string; children?: boolean },
  opts: { hardDelete?: TicketHardDelete } = {},
): Promise<ActionResult> {
  const { tx, agent } = ctx;
  if (!agent) return { error: "denied" };
  const t = await loadTicket(input.ticketId, agent.id, tx);
  if (!t || !(await checkStaffPerm(t, agent, undefined, tx))) return { error: "not_found" };
  const rec = await TicketRecord.load(tx, input.ticketId, true);
  if (!rec) return { error: "not_found" };
  const status = input.statusId ? await loadStatus(tx, input.statusId) : null;
  if (!status) return { error: "invalid_status" };
  // Solo stati del menu (abilitati, open/closed) o l'eliminazione: differenza voluta, vedi isSelectableStatus
  if (status.state.toLowerCase() !== "deleted" && !isSelectableStatus(status)) return { error: "invalid_status" };
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
      if (!role.perms.has(TicketPerm.DELETE)) return { error: "denied" };
      // Eliminazione definitiva: Ticket::delete è dell'area "ticketedit" (opts.hardDelete)
      if (!opts.hardDelete) return { error: "not_supported" };
      break;
    default:
      return { error: "invalid_status" };
  }

  const threadId = await ticketThreadId(tx, rec.id);
  const hardDelete = opts.hardDelete;
  const r = await setTicketStatus(ctx, rec, threadId, status.id, {
    comments: input.comments ?? "",
    logNote: (title, body) => logNote(ctx, rec.id, title, body),
    hardDelete: hardDelete ? () => hardDelete(ctx, rec, input.comments ?? "") : undefined,
  });
  if (r !== true) {
    // Ticket::isCloseable(): "... cannot be closed" (l'avviso tradotto è già nel modale)
    if (typeof r === "string" && / cannot be closed$/.test(r)) return { error: "not_closeable", detail: r };
    return { error: "status_failed", detail: typeof r === "string" ? r : undefined };
  }

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
      // $child->setStatus($status, '', $errors): nessun commento ai figli
      const cr = await setTicketStatus(ctx, child, childThread, status.id, {
        logNote: (title, body) => logNote(ctx, child.id, title, body),
        hardDelete: hardDelete ? () => hardDelete(ctx, child, "") : undefined,
      });
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
