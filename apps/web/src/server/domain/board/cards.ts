import "server-only";

import { sql } from "kysely";

import { coreConfig } from "../../config/config";
import { table, type DbOrTx } from "../../db";
import { fromDb, isZeroDate } from "../../db/time";
import { agentTimeZone, formatDbDate } from "../../format/datetime";
import { agentsName, usersName } from "../../format/persons-name";
import type { Agent } from "../staff/staff";
import { lockEnabled } from "../ticket/lock";
import { loadTicketRows, type TicketRow } from "../ticket/rows";
import { initials } from "@/lib/format/initials";

import { cardPermissions, isDueSoon, safeColor } from "./grouping";
import type { BoardCard, StatusState } from "./types";

/**
 * Lettura della board, parte card: dati dei ticket piazzati (loadTicketRows, le stesse righe della lista ticket),
 * agenti che hanno il lock e conversione in BoardCard con i permessi di cambio stato.
 */

/** Ticket scelto dalla query della board: colonna, swimlane e totale della cella. */
export interface Placed {
  ticket_id: number;
  grp: string;
  lane_key: string;
  cnt: number;
}

/** Impostazioni dell'agente e della configurazione usate per comporre card e intestazioni. */
export interface BoardContext {
  agent: Agent;
  locale: string;
  tz: string;
  agentNameFormat: string;
  clientNameFormat: string;
  /** lock dei ticket attivi (ticket_lock e autolock_minutes, come la vista del ticket) */
  locksEnabled: boolean;
}

export async function newContext(agent: Agent, locale: string): Promise<BoardContext> {
  const [cfg, tz] = await Promise.all([coreConfig(), agentTimeZone(agent)]);
  return {
    agent,
    locale,
    tz,
    agentNameFormat: cfg.str("agent_name_format", "full"),
    clientNameFormat: cfg.str("client_name_format", "original"),
    locksEnabled: lockEnabled(cfg),
  };
}

export const staffName = (r: Pick<TicketRow, "staff_first" | "staff_last">, ctx: BoardContext) =>
  agentsName(r.staff_first ?? "", r.staff_last ?? "", ctx.agentNameFormat).toString();

const hasStaff = (r: TicketRow) => r.staff_id > 0 && (r.staff_first !== null || r.staff_last !== null);

/** Agenti che hanno il lock attivo sui ticket (solo quelli bloccati da altri, già noti da loadTicketRows). */
async function lockHolders(rows: TicketRow[], ctx: BoardContext, executor: DbOrTx): Promise<Map<number, string>> {
  const ids = ctx.locksEnabled ? rows.filter((r) => r.locked_by_other).map((r) => r.ticket_id) : [];
  if (!ids.length) return new Map();
  const { rows: locks } = await sql<{ ticket_id: number; firstname: string | null; lastname: string | null }>`
    SELECT T.ticket_id, LS.firstname, LS.lastname FROM ${table("ticket")} T
    INNER JOIN ${table("lock")} LK ON (LK.lock_id = T.lock_id)
    LEFT JOIN ${table("staff")} LS ON (LS.staff_id = LK.staff_id)
    WHERE T.ticket_id IN (${sql.join(ids)})`.execute(executor);
  return new Map(
    locks.map((l) => [
      Number(l.ticket_id),
      agentsName(l.firstname ?? "", l.lastname ?? "", ctx.agentNameFormat).toString() || "?",
    ]),
  );
}

function toCard(r: TicketRow, place: { grp: string; lane_key: string }, ctx: BoardContext, locks: Map<number, string>, nowMs: number): BoardCard {
  const state: StatusState = r.status_state === "closed" ? "closed" : "open";
  let assignee: BoardCard["assignee"] = null;
  if (hasStaff(r)) {
    assignee = {
      kind: "staff",
      id: r.staff_id,
      name: staffName(r, ctx),
      initials: initials(`${r.staff_first ?? ""} ${r.staff_last ?? ""}`),
    };
  } else if (r.team_id > 0 && r.team_name !== null) {
    assignee = { kind: "team", id: r.team_id, name: r.team_name, initials: initials(r.team_name) };
  }
  const due = !isZeroDate(r.duedate) ? r.duedate : r.est_duedate;
  const dueMs = state === "open" ? (fromDb(due)?.toMillis() ?? null) : null;
  const updated = !isZeroDate(r.lastupdate) ? r.lastupdate : r.created;
  const perms = cardPermissions(ctx.agent, { deptId: r.dept_id, staffId: r.staff_id, teamId: r.team_id, state });
  return {
    id: r.ticket_id,
    number: r.number,
    subject: r.subject,
    user: usersName(r.user_name ?? "", ctx.clientNameFormat).toString(),
    priority: r.priority_id
      ? {
          id: Number(r.priority_id),
          name: r.priority ?? "",
          color: safeColor(r.priority_color),
          urgency: Number(r.priority_urgency ?? 99),
        }
      : null,
    assignee,
    dept: r.dept_name ?? "",
    topic: r.topic_name ?? "",
    statusId: r.status_id,
    status: r.status_name,
    state,
    overdue: state === "open" && r.isoverdue,
    dueSoon: state === "open" && !r.isoverdue && isDueSoon(dueMs, nowMs),
    dueLabel: dueMs === null ? null : formatDbDate(due, ctx.tz, ctx.locale),
    updatedLabel: formatDbDate(updated, ctx.tz, ctx.locale, "human"),
    updatedTitle: formatDbDate(updated, ctx.tz, ctx.locale),
    updatedMs: fromDb(updated)?.toMillis() ?? 0,
    threadCount: r.thread_count,
    attachments: r.attachment_count,
    lockedBy: ctx.locksEnabled && r.locked_by_other ? (locks.get(r.ticket_id) ?? "?") : null,
    canClose: perms.canClose,
    canReopen: perms.canReopen,
    col: String(place.grp),
    lane: String(place.lane_key),
  };
}

/** Card dei ticket dati, con i dati della lista ticket (loadTicketRows); anche le righe, per le intestazioni. */
export async function cardsFor(
  placed: Placed[],
  ctx: BoardContext,
  executor: DbOrTx,
): Promise<{ cards: Map<number, BoardCard>; rows: Map<number, TicketRow> }> {
  const rows = await loadTicketRows(
    placed.map((p) => p.ticket_id),
    ctx.agent.id,
    executor,
  );
  const locks = await lockHolders(rows, ctx, executor);
  const byId = new Map(rows.map((r) => [r.ticket_id, r]));
  const nowMs = Date.now();
  const out = new Map<number, BoardCard>();
  for (const p of placed) {
    const r = byId.get(p.ticket_id);
    if (r) out.set(p.ticket_id, toCard(r, p, ctx, locks, nowMs));
  }
  return { cards: out, rows: byId };
}
