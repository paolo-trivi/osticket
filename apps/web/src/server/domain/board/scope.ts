import "server-only";

import { sql, type RawBuilder } from "kysely";

import { table, type DbOrTx } from "../../db";
import { agentQueueNav } from "../queue/context";
import {
  adhocQueue,
  mergeChildFilterSql,
  queueScope,
  queueScopeIdsSql,
  quickSearchCriteria,
  visibilitySql,
  type TicketQueue,
} from "../queue/engine";
import type { Agent } from "../staff/staff";
import { criteriaStates } from "./grouping";
import {
  RECENT_CLOSED_DAYS,
  type BoardGroupBy,
  type BoardLaneBy,
  type BoardParams,
} from "./params";
import type { BoardError } from "./types";

/**
 * Lettura della board, parte SQL: tabelle, chiavi di colonna/swimlane, ordine delle card, sorgente (coda o tutti i
 * ticket visibili, più la ricerca rapida) e filtri rapidi. Le query vere stanno in board.ts.
 * Alias SQL come il motore code (T, ST, CD, PR, S, TM, D): MySQL su Linux distingue maiuscole e minuscole.
 */

type Sql = RawBuilder<unknown>;

export const FROM: Sql = sql`FROM ${table("ticket")} T
  INNER JOIN ${table("ticket_status")} ST ON (ST.id = T.status_id)
  LEFT JOIN ${table("ticket__cdata")} CD ON (CD.ticket_id = T.ticket_id)
  LEFT JOIN ${table("ticket_priority")} PR ON (PR.priority_id = CD.priority)
  LEFT JOIN ${table("staff")} S ON (S.staff_id = T.staff_id)
  LEFT JOIN ${table("team")} TM ON (TM.team_id = T.team_id)`;

/** Ordine delle card nella cella: priorità, ultimo aggiornamento, id (totale e stabile per "carica altri"). */
export const CARD_ORDER: Sql = sql`COALESCE(PR.priority_urgency, 99) ASC, T.lastupdate DESC, T.ticket_id DESC`;

/** Chiave di colonna o swimlane di un ticket. */
export function keyExpr(by: BoardGroupBy | BoardLaneBy): Sql {
  switch (by) {
    case "status":
      return sql`CAST(T.status_id AS CHAR)`;
    case "priority":
      return sql`CAST(COALESCE(PR.priority_id, 0) AS CHAR)`;
    case "dept":
      return sql`CAST(T.dept_id AS CHAR)`;
    case "assignee":
      return sql`(CASE WHEN T.staff_id > 0 AND S.staff_id IS NOT NULL THEN CONCAT('s', T.staff_id)
        WHEN T.team_id > 0 AND TM.team_id IS NOT NULL THEN CONCAT('t', T.team_id) ELSE 'u' END)`;
    case "none":
      return sql`'all'`;
  }
}

interface Scope {
  where: Sql[];
  title: string;
  /** stati ammessi dalla coda sorgente (null = nessun limite noto) */
  states: Set<string> | null;
}

type ScopeResult = Scope | { error: BoardError; title: string };

/** Ticket di una coda o ricerca come sottoquery `T.ticket_id IN (…)` (scope del motore code). */
async function scopeIn(agent: Agent, queue: TicketQueue, tz: string, executor: DbOrTx): Promise<{ sql: Sql; tooShort: boolean }> {
  const scope = await queueScope(agent, queue, { userTz: tz }, {}, executor);
  return {
    sql: sql`T.ticket_id IN (${queueScopeIdsSql(scope)})`,
    // testo full-text troppo corto: la lista non filtra (come il PHP); la board lo segnala
    tooShort: scope.keywords !== null && !scope.keywordJoin,
  };
}

/** Condizioni della sorgente scelta (coda navigabile o tutti i visibili) e della ricerca rapida. */
export async function resolveScope(agent: Agent, params: BoardParams, tz: string, executor: DbOrTx): Promise<ScopeResult> {
  const where: Sql[] = [];
  let title = "";
  let states: Set<string> | null = null;
  if (params.source === "all") {
    // Tutti i ticket visibili: stessa visibilità e stesso filtro sui figli dei merge delle code
    where.push(visibilitySql(agent, false), mergeChildFilterSql());
  } else {
    const { queues } = await agentQueueNav(agent);
    const queue = queues.find((q) => q.id === params.source);
    if (!queue) return { error: "notFound", title };
    title = queue.title;
    states = criteriaStates(queue.effectiveCriteria());
    const s = await scopeIn(agent, queue, tz, executor);
    if (s.tooShort) return { error: "tooShort", title };
    where.push(s.sql);
  }
  if (params.q) {
    const criteria = quickSearchCriteria(params.q);
    if (!criteria) return { error: "tooManyWords", title };
    const s = await scopeIn(agent, adhocQueue(agent, criteria, params.q), tz, executor);
    if (s.tooShort) return { error: "tooShort", title };
    where.push(s.sql);
  }
  return { where, title, states };
}

/** Chiusi da più di RECENT_CLOSED_DAYS giorni (esclusi salvo `older`). */
export const OLDER_CLOSED: Sql = sql`ST.state = 'closed' AND NOT (T.closed >= NOW() - INTERVAL ${sql.lit(RECENT_CLOSED_DAYS)} DAY)`;

/** Filtri rapidi e stati mostrati (aperti; chiusi solo se recenti, salvo `older`). */
export function filterSql(agent: Agent, p: BoardParams): Sql[] {
  const out: Sql[] = [];
  const recent = sql`T.closed >= NOW() - INTERVAL ${sql.lit(RECENT_CLOSED_DAYS)} DAY`;
  out.push(p.older ? sql`ST.state IN ('open', 'closed')` : sql`(ST.state = 'open' OR (ST.state = 'closed' AND ${recent}))`);
  if (p.mine) out.push(sql`T.staff_id = ${sql.lit(agent.id)}`);
  else if (p.unassigned) out.push(sql`(T.staff_id = 0 AND T.team_id = 0)`);
  if (p.overdue) out.push(sql`(T.isoverdue = 1 AND ST.state = 'open')`);
  if (p.prio.length) out.push(sql`PR.priority_id IN (${sql.join(p.prio.map((id) => sql.lit(Math.trunc(id))))})`);
  return out;
}
