import "server-only";

import { sql, type RawBuilder } from "kysely";

import { db, table, type DbOrTx } from "../../db";
import { loadSort, queueColumns, type QueueSortDef } from "./columns";
import { resolveTables, type FieldDef, type JoinKey } from "./fields";
import type { TicketQueue } from "./queues";
import { joinsFor, loadFieldRegistry, type FieldRegistry } from "./scope";

/** Ordinamento della lista di una coda (QueueColumn::applySort, QueueSort, queue-tickets.tmpl.php). */

export interface SortOptions {
  /** ?sort=<id colonna> oppure "qs-<id ordinamento>" */
  sort?: string;
  dir?: 0 | 1;
}

interface OrderKey {
  expr: RawBuilder<unknown>;
  desc: boolean;
}

function orderFor(field: FieldDef | undefined, desc: boolean, joins: Set<JoinKey>): OrderKey[] {
  if (!field) return [];
  const sortDef = field.sort;
  const cols = sortDef?.cols ?? [field.col];
  sortDef?.joins?.forEach((j) => joins.add(j));
  field.joins.forEach((j) => joins.add(j));
  const d = sortDef?.invert ? !desc : desc;
  return cols.map((c) => ({ expr: sql.raw(resolveTables(c)), desc: d }));
}

/** Ordinamento come queue-tickets.tmpl.php: colonna cliccata, poi ordinamento della coda, poi -created. */
export async function queueOrder(
  queue: TicketQueue,
  opts: SortOptions,
  fields: FieldRegistry,
  joins: Set<JoinKey>,
  executor: DbOrTx = db(),
): Promise<OrderKey[]> {
  const dir = opts.dir === 1;
  if (opts.sort && /^\d+$/.test(opts.sort)) {
    const col = (await queueColumns(queue, executor)).find((c) => c.id === Number(opts.sort));
    if (col) {
      const primary = fields.get(col.primary);
      const secondary = col.secondary ? fields.get(col.secondary) : undefined;
      if (primary && secondary) {
        // QueueColumn::applySort con due chiavi: COALESCE(primaria, secondaria, 'zzz')
        primary.joins.forEach((j) => joins.add(j));
        secondary.joins.forEach((j) => joins.add(j));
        return [
          {
            expr: sql`COALESCE(${sql.raw(resolveTables(primary.col))}, ${sql.raw(resolveTables(secondary.col))}, 'zzz')`,
            desc: dir,
          },
        ];
      }
      if (primary) return orderFor(primary, dir, joins);
    }
  }
  let sortDef: QueueSortDef | null = null;
  if (opts.sort?.startsWith("qs-")) sortDef = await loadSort(Number(opts.sort.slice(3)), executor);
  if (!sortDef) {
    const def = queue.defaultSortId();
    if (def) sortDef = await loadSort(def, executor);
  }
  if (sortDef) {
    const out: OrderKey[] = [];
    for (const c of sortDef.columns) out.push(...orderFor(fields.get(c.path), dir ? !c.desc : c.desc, joins));
    if (out.length) return out;
  }
  return [{ expr: sql`T.created`, desc: true }];
}

export const orderSql = (keys: OrderKey[]) => keys.map((k) => sql`${k.expr} ${sql.raw(k.desc ? "DESC" : "ASC")}`);

/** Valori delle chiavi di ordinamento per un insieme di ticket (serve ai test sui pari merito). */
export async function orderKeyValues(
  queue: TicketQueue,
  opts: SortOptions,
  ids: number[],
  executor: DbOrTx = db(),
): Promise<Map<number, string>> {
  if (!ids.length) return new Map();
  const fields = await loadFieldRegistry(executor);
  const joins = new Set<JoinKey>(["ST"]);
  const keys = await queueOrder(queue, opts, fields, joins, executor);
  const { rows } = await sql<{ ticket_id: number; k: string }>`
    SELECT T.ticket_id, CONCAT_WS('|', ${sql.join(keys.map((k) => sql`COALESCE(${k.expr}, '∅')`))}) AS k
    FROM ${table("ticket")} T ${joinsFor(joins)} WHERE T.ticket_id IN (${sql.join(ids)})`.execute(executor);
  return new Map(rows.map((r) => [Number(r.ticket_id), String(r.k)]));
}
