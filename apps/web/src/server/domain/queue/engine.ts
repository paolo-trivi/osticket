import "server-only";

import { sql, type RawBuilder } from "kysely";

import { db, table, type DbOrTx } from "../../db";
import type { Agent } from "../staff/staff";
import type { Criterion, JoinKey } from "./fields";
import { orderSql, queueOrder, type SortOptions } from "./order";
import type { TicketQueue } from "./queues";
import { compileCriteria, joinsFor, loadFieldRegistry, queueScope, visibilitySql, type FieldRegistry } from "./scope";
import { keywordTicketIds } from "./search";

/**
 * Lettura delle code dei ticket (SavedQueue di include/class.queue.php e class.search.php): lista paginata,
 * contatori della navigazione ed export. Modello delle code in queues.ts, SQL dei criteri in scope.ts,
 * colonne e ordinamenti in columns.ts e order.ts.
 */

interface ListOptions extends SortOptions {
  page?: number;
  pageSize: number;
  /** ricerca rapida aggiuntiva (barra di ricerca) */
  extraCriteria?: Criterion[];
}

interface ListResult {
  ids: number[];
  total: number | null;
  page: number;
  pageSize: number;
}

export async function listQueueTickets(
  agent: Agent,
  queue: TicketQueue,
  opts: ListOptions,
  ctx: { userTz: string },
  executor: DbOrTx = db(),
): Promise<ListResult> {
  const scope = await queueScope(agent, queue, ctx, { extraCriteria: opts.extraCriteria }, executor);
  const { fields, joins, conditions: conds, keywordJoin } = scope;
  const kwJoin = keywordJoin ?? sql``;

  const keys = keywordJoin ? [] : await queueOrder(queue, opts, fields, joins, executor);
  // Ordinamento stabile: T.ticket_id come ultima chiave (nella direzione della prima). Il PHP ordina solo per
  // le chiavi della coda, quindi a pari merito un ticket poteva ripetersi o mancare tra una pagina e l'altra.
  const order = keywordJoin
    ? [sql`MAX(KW.relevance) DESC`, sql`T.ticket_id DESC`]
    : [...orderSql(keys), sql`T.ticket_id ${sql.raw(keys[0]?.desc ? "DESC" : "ASC")}`];
  const page = Math.max(1, opts.page ?? 1);
  const offset = (page - 1) * opts.pageSize;
  const where = sql.join(conds, sql` AND `);

  const { rows } = await sql<{ ticket_id: number }>`
    SELECT T.ticket_id FROM ${table("ticket")} T ${joinsFor(joins)} ${kwJoin}
    WHERE ${where}
    GROUP BY T.ticket_id
    ORDER BY ${sql.join(order)}
    LIMIT ${opts.pageSize} OFFSET ${offset}`.execute(executor);

  // Totale della paginazione contato con le stesse condizioni della lista. Il PHP usa il contatore della coda
  // (SavedQueue::counts: senza archiviati e con un altro filtro sui figli dei merge), quindi pagine mancanti o
  // vuote. I contatori della navigazione restano quelli del PHP (queueCounts).
  const { rows: countRows } = await sql<{ n: number }>`
    SELECT COUNT(DISTINCT T.ticket_id) AS n FROM ${table("ticket")} T ${joinsFor(joins)} ${kwJoin}
    WHERE ${where}`.execute(executor);
  const total = Number(countRows[0]?.n ?? 0);
  return { ids: rows.map((r) => Number(r.ticket_id)), total, page, pageSize: opts.pageSize };
}

export async function queueCounts(
  agent: Agent,
  queues: TicketQueue[],
  ctx: { userTz: string },
  executor: DbOrTx = db(),
  registry?: FieldRegistry,
): Promise<Map<number, number | "-">> {
  const fields = registry ?? (await loadFieldRegistry(executor));
  const result = new Map<number, number | "-">();
  const joins = new Set<JoinKey>(["ST", "TH"]);
  const selects: RawBuilder<unknown>[] = [];
  for (const q of queues) {
    const crit = compileCriteria(q.effectiveCriteria(), fields, { agent, userTz: ctx.userTz });
    if (crit.keywords !== null || !crit.conditions.length) {
      result.set(q.id, "-");
      continue;
    }
    crit.joins.forEach((j) => joins.add(j));
    const conds = [...crit.conditions];
    if (q.isAQueue || q.isASubQueue) conds.push(sql`TH.object_type = 'T'`);
    selects.push(sql`COUNT(DISTINCT CASE WHEN ${sql.join(conds, sql` AND `)} THEN T.ticket_id END) AS ${sql.ref(`q${q.id}`)}`);
  }
  if (!selects.length) return result;
  const { rows } = await sql<Record<string, number>>`
    SELECT ${sql.join(selects)} FROM ${table("ticket")} T ${joinsFor(joins)}
    WHERE ${visibilitySql(agent, true)}`.execute(executor);
  for (const [k, v] of Object.entries(rows[0] ?? {})) result.set(Number(k.slice(1)), Number(v));
  return result;
}

/**
 * Id dei ticket di una coda per l'export CSV (CustomQueue::export, area "ticketedit"): stessi criteri,
 * visibilità e ordinamento della lista, ma senza paginazione e senza il filtro sui figli dei merge
 * (l'export del PHP non lo applica).
 */
export async function exportQueueTicketIds(
  agent: Agent,
  queue: TicketQueue,
  opts: SortOptions,
  ctx: { userTz: string },
  executor: DbOrTx = db(),
): Promise<number[]> {
  // Scope della lista senza filtro sui figli dei merge; full-text come lista di id (max 500, come il PHP)
  const scope = await queueScope(agent, queue, ctx, { mergeFilter: false }, executor);
  const { fields, joins } = scope;
  const conds: RawBuilder<unknown>[] = [...scope.conditions];
  if (scope.keywords !== null) {
    const ids = await keywordTicketIds(scope.keywords, executor);
    if (ids !== null) conds.push(ids.length ? sql`T.ticket_id IN (${sql.join(ids)})` : sql`(0)`);
  }
  const order = orderSql(await queueOrder(queue, opts, fields, joins, executor));
  const { rows } = await sql<{ ticket_id: number }>`
    SELECT T.ticket_id FROM ${table("ticket")} T ${joinsFor(joins)}
    ${conds.length ? sql`WHERE ${sql.join(conds, sql` AND `)}` : sql``}
    GROUP BY T.ticket_id
    ORDER BY ${sql.join(order)}`.execute(executor);
  return rows.map((r) => Number(r.ticket_id));
}
