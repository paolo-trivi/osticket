import "server-only";

import { sql } from "kysely";

import { db, type DbOrTx } from "../../db";
import type { Agent } from "../staff/staff";
import { ticketStatusChoices } from "../ticket/ticket-state";
import { cardsFor, newContext, type Placed } from "./cards";
import { buildCells, buildColumns, buildLanes, firstTickets } from "./layout";
import type { BoardParams } from "./params";
import { CARD_ORDER, filterSql, FROM, keyExpr, OLDER_CLOSED, resolveScope } from "./scope";
import type { BoardCard, BoardData, BoardError } from "./types";

export { boardPriorities, boardSources } from "./sources";

/**
 * Board Kanban dei ticket costruita sul motore code di main: la sorgente è una coda navigabile dell'agente
 * (queueScope: stessi criteri, visibilità e filtro sui figli dei merge della lista) oppure tutti i ticket
 * visibili (visibilitySql + filtro sui figli dei merge). Sopra la sorgente: ricerca rapida (stessi criteri
 * della barra di ricerca della lista), filtri rapidi e solo ticket aperti o chiusi di recente.
 *
 * Query: una con funzioni finestra (ROW_NUMBER/COUNT per colonna × swimlane) sceglie le prime N card di ogni
 * cella con il totale; i dati delle card arrivano da loadTicketRows (le stesse righe della lista ticket); una
 * query aggregata conta i chiusi meno recenti esclusi. Sola lettura: il cambio stato passa da
 * changeTicketStatus (actions.ts della pagina).
 *
 * Moduli: scope.ts (SQL di sorgente e filtri), cards.ts (dati delle card), layout.ts (colonne, celle e swimlane),
 * sources.ts (scelte della barra); qui solo l'orchestrazione delle query.
 */

const PER_CELL = 25;
const PER_CELL_WITH_LANES = 8;
const MAX_PAGE = 100;

/** Board completa per i parametri dati. */
export async function loadBoard(agent: Agent, params: BoardParams, locale: string, executor: DbOrTx = db()): Promise<BoardData> {
  const perCell = params.lane === "none" ? PER_CELL : PER_CELL_WITH_LANES;
  const base: BoardData = {
    group: params.group,
    lane: params.lane,
    columns: [],
    lanes: [],
    cells: {},
    total: 0,
    olderClosed: 0,
    perCell,
    sourceTitle: "",
    sourceHasClosed: true,
    dragEnabled: params.group === "status",
  };
  const ctx = await newContext(agent, locale);
  const [scope, statuses, priorities] = await Promise.all([
    resolveScope(agent, params, ctx.tz, executor),
    // Colonne di stato: stati abilitati open/closed del menu "Cambia stato" (mai "deleted")
    params.group === "status" ? ticketStatusChoices(executor) : Promise.resolve([]),
    executor
      .selectFrom("ticket_priority")
      .select(["priority_id", "priority_desc", "priority_color", "priority_urgency"])
      .orderBy("priority_urgency")
      .execute(),
  ]);
  base.sourceTitle = scope.title;
  if ("error" in scope) return { ...base, error: scope.error };
  base.sourceHasClosed = !scope.states || scope.states.has("closed");
  if (params.group === "status" && !statuses.length) return { ...base, error: "noStatuses" };

  const g = keyExpr(params.group);
  const l = keyExpr(params.lane);
  const whereSql = sql.join([...scope.where, ...filterSql(agent, params)], sql` AND `);

  const olderNeeded = !params.older && base.sourceHasClosed;
  const [{ rows: placed }, older] = await Promise.all([
    sql<Placed>`SELECT x.ticket_id, x.grp, x.lane_key, x.cnt FROM (
        SELECT T.ticket_id, ${g} AS grp, ${l} AS lane_key,
          ROW_NUMBER() OVER (PARTITION BY ${g}, ${l} ORDER BY ${CARD_ORDER}) AS rn,
          COUNT(*) OVER (PARTITION BY ${g}, ${l}) AS cnt
        ${FROM} WHERE ${whereSql}
      ) x WHERE x.rn <= ${sql.lit(perCell)} ORDER BY x.grp, x.lane_key, x.rn`.execute(executor),
    olderNeeded
      ? sql<{ grp: string; lane_key: string; n: number }>`SELECT ${g} AS grp, ${l} AS lane_key, COUNT(*) AS n ${FROM}
          WHERE ${sql.join([...scope.where, ...filterSql(agent, { ...params, older: true }), OLDER_CLOSED], sql` AND `)} GROUP BY grp, lane_key`.execute(executor)
      : Promise.resolve({ rows: [] as Array<{ grp: string; lane_key: string; n: number }> }),
  ]);
  const places = placed.map((p) => ({
    ticket_id: Number(p.ticket_id),
    grp: String(p.grp),
    lane_key: String(p.lane_key),
    cnt: Number(p.cnt),
  }));
  const { cards, rows: rowOf } = await cardsFor(places, ctx, executor);
  const { firstCol, firstLane } = firstTickets(places);

  const columns = buildColumns(params.group, { statuses, priorities, firstCol, cards, rowOf, ctx });
  const { cells, laneTotals, olderClosed } = buildCells(places, cards, older.rows);
  const lanes = buildLanes(params.lane, { firstLane, laneTotals, rowOf, ctx });

  return { ...base, columns, lanes, cells, total: lanes.reduce((a, b) => a + b.total, 0), olderClosed };
}

/** Altre card di una cella ("carica altri"), nello stesso ordine della board. */
export async function loadBoardCell(
  agent: Agent,
  params: BoardParams,
  locale: string,
  cell: { lane: string; col: string; offset: number; limit?: number },
  executor: DbOrTx = db(),
): Promise<{ cards: BoardCard[]; total: number } | { error: BoardError }> {
  const ctx = await newContext(agent, locale);
  const scope = await resolveScope(agent, params, ctx.tz, executor);
  if ("error" in scope) return { error: scope.error };
  const g = keyExpr(params.group);
  const l = keyExpr(params.lane);
  const where = sql.join([...scope.where, ...filterSql(agent, params), sql`${g} = ${cell.col}`, sql`${l} = ${cell.lane}`], sql` AND `);
  const limit = Math.min(MAX_PAGE, Math.max(1, Math.trunc(cell.limit ?? PER_CELL)));
  const offset = Math.max(0, Math.trunc(cell.offset));
  const [{ rows }, total] = await Promise.all([
    sql<{ ticket_id: number }>`SELECT T.ticket_id ${FROM} WHERE ${where}
      ORDER BY ${CARD_ORDER} LIMIT ${sql.lit(limit)} OFFSET ${sql.lit(offset)}`.execute(executor),
    sql<{ n: number }>`SELECT COUNT(*) AS n ${FROM} WHERE ${where}`.execute(executor),
  ]);
  const places = rows.map((r) => ({ ticket_id: Number(r.ticket_id), grp: cell.col, lane_key: cell.lane, cnt: 0 }));
  const { cards } = await cardsFor(places, ctx, executor);
  return {
    cards: places.map((p) => cards.get(p.ticket_id)).filter((c): c is BoardCard => !!c),
    total: Number(total.rows[0]?.n ?? 0),
  };
}
