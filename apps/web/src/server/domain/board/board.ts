import "server-only";

import { sql, type RawBuilder } from "kysely";

import { coreConfig } from "../../config/config";
import { db, table, type DbOrTx } from "../../db";
import { fromDb, isZeroDate } from "../../db/time";
import { agentTimeZone, formatDbDate } from "../../format/datetime";
import { agentsName, usersName } from "../../format/persons-name";
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
import { lockEnabled } from "../ticket/lock";
import { loadTicketRows, type TicketRow } from "../ticket/rows";
import { ticketStatusChoices } from "../ticket/ticket-state";
import {
  cardPermissions,
  criteriaStates,
  initials,
  isDueSoon,
  orderDerived,
  safeColor,
} from "./grouping";
import {
  RECENT_CLOSED_DAYS,
  type BoardGroupBy,
  type BoardLaneBy,
  type BoardParams,
} from "./params";
import {
  cellKey,
  type BoardCard,
  type BoardCell,
  type BoardColumn,
  type BoardData,
  type BoardError,
  type BoardLane,
  type BoardSourceOption,
  type StatusState,
} from "./types";

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
 * Alias SQL come il motore code (T, ST, CD, PR, S, TM, D): MySQL su Linux distingue maiuscole e minuscole.
 */

const PER_CELL = 25;
const PER_CELL_WITH_LANES = 8;
const MAX_PAGE = 100;

type Sql = RawBuilder<unknown>;

const FROM: Sql = sql`FROM ${table("ticket")} T
  INNER JOIN ${table("ticket_status")} ST ON (ST.id = T.status_id)
  LEFT JOIN ${table("ticket__cdata")} CD ON (CD.ticket_id = T.ticket_id)
  LEFT JOIN ${table("ticket_priority")} PR ON (PR.priority_id = CD.priority)
  LEFT JOIN ${table("staff")} S ON (S.staff_id = T.staff_id)
  LEFT JOIN ${table("team")} TM ON (TM.team_id = T.team_id)`;

/** Ordine delle card nella cella: priorità, ultimo aggiornamento, id (totale e stabile per "carica altri"). */
const CARD_ORDER: Sql = sql`COALESCE(PR.priority_urgency, 99) ASC, T.lastupdate DESC, T.ticket_id DESC`;

function keyExpr(by: BoardGroupBy | BoardLaneBy): Sql {
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

interface Placed {
  ticket_id: number;
  grp: string;
  lane_key: string;
  cnt: number;
}

interface Scope {
  where: Sql[];
  title: string;
  /** stati ammessi dalla coda sorgente (null = nessun limite noto) */
  states: Set<string> | null;
}

type ScopeResult = Scope | { error: BoardError; title: string };

interface Context {
  agent: Agent;
  locale: string;
  tz: string;
  agentNameFormat: string;
  clientNameFormat: string;
  /** lock dei ticket attivi (ticket_lock e autolock_minutes, come la vista del ticket) */
  locksEnabled: boolean;
}

/** Ticket di una coda o ricerca come sottoquery `T.ticket_id IN (…)` (scope del motore code). */
async function scopeIn(agent: Agent, queue: TicketQueue, tz: string, executor: DbOrTx): Promise<{ sql: Sql; tooShort: boolean }> {
  const scope = await queueScope(agent, queue, { userTz: tz }, {}, executor);
  return {
    sql: sql`T.ticket_id IN (${queueScopeIdsSql(scope)})`,
    // testo full-text troppo corto: la lista non filtra (come il PHP); la board lo segnala
    tooShort: scope.keywords !== null && !scope.keywordJoin,
  };
}

async function resolveScope(agent: Agent, params: BoardParams, tz: string, executor: DbOrTx): Promise<ScopeResult> {
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

/** Filtri rapidi e stati mostrati (aperti; chiusi solo se recenti, salvo `older`). */
function filterSql(agent: Agent, p: BoardParams): Sql[] {
  const out: Sql[] = [];
  const recent = sql`T.closed >= NOW() - INTERVAL ${sql.lit(RECENT_CLOSED_DAYS)} DAY`;
  out.push(p.older ? sql`ST.state IN ('open', 'closed')` : sql`(ST.state = 'open' OR (ST.state = 'closed' AND ${recent}))`);
  if (p.mine) out.push(sql`T.staff_id = ${sql.lit(agent.id)}`);
  else if (p.unassigned) out.push(sql`(T.staff_id = 0 AND T.team_id = 0)`);
  if (p.overdue) out.push(sql`(T.isoverdue = 1 AND ST.state = 'open')`);
  if (p.prio.length) out.push(sql`PR.priority_id IN (${sql.join(p.prio.map((id) => sql.lit(Math.trunc(id))))})`);
  return out;
}

async function newContext(agent: Agent, locale: string): Promise<Context> {
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

const staffName = (r: Pick<TicketRow, "staff_first" | "staff_last">, ctx: Context) =>
  agentsName(r.staff_first ?? "", r.staff_last ?? "", ctx.agentNameFormat).toString();

const hasStaff = (r: TicketRow) => r.staff_id > 0 && (r.staff_first !== null || r.staff_last !== null);

/** Agenti che hanno il lock attivo sui ticket (solo quelli bloccati da altri, già noti da loadTicketRows). */
async function lockHolders(rows: TicketRow[], ctx: Context, executor: DbOrTx): Promise<Map<number, string>> {
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

function toCard(r: TicketRow, place: { grp: string; lane_key: string }, ctx: Context, locks: Map<number, string>, nowMs: number): BoardCard {
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
async function cardsFor(
  placed: Placed[],
  ctx: Context,
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

/** Colonna/swimlane derivata da una card (raggruppamenti per priorità, assegnatario, reparto). */
function derivedHeader(
  by: "priority" | "assignee" | "dept",
  key: string,
  r: TicketRow | undefined,
  ctx: Context,
): BoardColumn & { urgency?: number } {
  switch (by) {
    case "priority":
      if (key === "0" || !r) return { key, title: "", special: "noPriority", urgency: 99 };
      return {
        key,
        title: r.priority ?? key,
        color: safeColor(r.priority_color),
        urgency: Number(r.priority_urgency ?? 99),
      };
    case "dept":
      return r?.dept_name ? { key, title: r.dept_name } : { key, title: "", special: "noDept" };
    case "assignee": {
      if (key === "u" || !r) return { key, title: "", special: "unassigned" };
      if (key.startsWith("s")) {
        return {
          key,
          title: staffName(r, ctx),
          assigneeKind: "staff",
          initials: initials(`${r.staff_first ?? ""} ${r.staff_last ?? ""}`),
          isMe: Number(key.slice(1)) === ctx.agent.id,
        };
      }
      const title = r.team_name ?? "";
      return { key, title, assigneeKind: "team", initials: initials(title) };
    }
  }
}

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
          WHERE ${sql.join(
            [
              ...scope.where,
              ...filterSql(agent, { ...params, older: true }),
              sql`ST.state = 'closed' AND NOT (T.closed >= NOW() - INTERVAL ${sql.lit(RECENT_CLOSED_DAYS)} DAY)`,
            ],
            sql` AND `,
          )} GROUP BY grp, lane_key`.execute(executor)
      : Promise.resolve({ rows: [] as Array<{ grp: string; lane_key: string; n: number }> }),
  ]);
  const places = placed.map((p) => ({
    ticket_id: Number(p.ticket_id),
    grp: String(p.grp),
    lane_key: String(p.lane_key),
    cnt: Number(p.cnt),
  }));
  const { cards, rows: rowOf } = await cardsFor(places, ctx, executor);
  // intestazioni derivate dalla prima card di ogni colonna/swimlane
  const firstCol = new Map<string, number>();
  const firstLane = new Map<string, number>();
  for (const p of places) {
    if (!firstCol.has(p.grp)) firstCol.set(p.grp, p.ticket_id);
    if (!firstLane.has(p.lane_key)) firstLane.set(p.lane_key, p.ticket_id);
  }

  // Colonne
  const columns: BoardColumn[] = [];
  if (params.group === "status") {
    const seen = new Set<string>();
    for (const s of statuses) {
      columns.push({ key: String(s.id), title: s.name, statusId: s.id, state: s.state === "closed" ? "closed" : "open" });
      seen.add(String(s.id));
    }
    // Ticket in uno stato non proposto dal menu (es. stato disattivato): colonna in coda, non come destinazione
    for (const [key, id] of firstCol) {
      if (seen.has(key)) continue;
      const c = cards.get(id);
      columns.push({ key, title: c?.status ?? key });
    }
  } else if (params.group === "priority") {
    for (const p of priorities) {
      columns.push({ key: String(p.priority_id), title: p.priority_desc, color: safeColor(p.priority_color) });
    }
    if (firstCol.has("0")) columns.push({ key: "0", title: "", special: "noPriority" });
  } else {
    const by = params.group;
    columns.push(
      ...orderDerived(
        by,
        [...firstCol].map(([key, id]) => derivedHeader(by, key, rowOf.get(id), ctx)),
        "column",
      ),
    );
  }

  // Celle e swimlane
  const laneTotals = new Map<string, number>();
  const cells: Record<string, BoardCell> = {};
  for (const p of places) {
    const card = cards.get(p.ticket_id);
    if (!card) continue;
    const key = cellKey(p.lane_key, p.grp);
    let cell = cells[key];
    if (!cell) {
      cell = cells[key] = { cards: [], total: p.cnt, olderClosed: 0 };
      laneTotals.set(p.lane_key, (laneTotals.get(p.lane_key) ?? 0) + cell.total);
    }
    cell.cards.push(card);
  }
  let olderClosed = 0;
  for (const o of older.rows) {
    const key = cellKey(String(o.lane_key), String(o.grp));
    const n = Number(o.n);
    olderClosed += n;
    (cells[key] ??= { cards: [], total: 0, olderClosed: 0 }).olderClosed = n;
  }

  let lanes: BoardLane[];
  if (params.lane === "none") {
    lanes = [{ key: "all", title: "", special: "all", total: [...laneTotals.values()].reduce((a, b) => a + b, 0) }];
  } else {
    const by = params.lane;
    lanes = orderDerived(
      by,
      [...firstLane].map(([key, id]) => derivedHeader(by, key, rowOf.get(id), ctx)),
      "lane",
    ).map((h) => ({ ...h, total: laneTotals.get(h.key) ?? 0 }));
  }

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

/**
 * Sorgenti selezionabili: le code navigabili dell'agente (agentQueueNav, come la barra laterale) ad albero,
 * poi le ricerche personali. Titoli grezzi: la pagina li traduce come la lista ticket.
 */
export async function boardSources(agent: Agent): Promise<BoardSourceOption[]> {
  const { queues, top, counts } = await agentQueueNav(agent);
  const navigable = new Set(queues.map((q) => q.id));
  const out: BoardSourceOption[] = [];
  const walk = (nodes: TicketQueue[], depth: number) => {
    for (const q of nodes) {
      const c = counts.get(q.id);
      out.push({ value: String(q.id), title: q.title, depth, count: c === undefined ? null : c });
      walk(
        q.children.filter((ch) => navigable.has(ch.id)),
        depth + 1,
      );
    }
  };
  walk(
    top.filter((q) => q.isAQueue),
    0,
  );
  walk(
    top.filter((q) => !q.isAQueue),
    0,
  );
  return out;
}

/** Priorità per i filtri rapidi (ordinate per urgenza). */
export async function boardPriorities(executor: DbOrTx = db()): Promise<Array<{ id: number; name: string; color: string | null }>> {
  const rows = await executor
    .selectFrom("ticket_priority")
    .select(["priority_id", "priority_desc", "priority_color"])
    .orderBy("priority_urgency")
    .execute();
  return rows.map((r) => ({ id: r.priority_id, name: r.priority_desc, color: safeColor(r.priority_color) }));
}
