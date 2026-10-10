import "server-only";

import { QueueColumn } from "@/lib/osticket/flags";

import { db, type DbOrTx } from "../../db";
import { phpJsonDecode } from "../../format/php-json";
import type { Criterion } from "./fields";
import type { TicketQueue } from "./queues";

/** Colonne e ordinamenti configurati di una coda (QueueColumn, QueueSort di include/class.queue.php). */

export interface QueueColumnDef {
  id: number;
  heading: string;
  width: number;
  primary: string;
  secondary: string | null;
  filter: string | null;
  truncate: string | null;
  annotations: { c: string; p: string }[];
  conditions: { crit: Criterion; prop: Record<string, string> }[];
  sortable: boolean;
}

export interface QueueSortDef {
  id: number;
  name: string;
  columns: { path: string; desc: boolean }[];
}

async function loadColumnDefs(queue: TicketQueue, executor: DbOrTx): Promise<QueueColumnDef[]> {
  const src = queue.columnsSource();
  let rows = await executor
    .selectFrom("queue_columns as qc")
    .innerJoin("queue_column as c", "c.id", "qc.column_id")
    .select(["c.id", "qc.heading", "qc.width", "qc.sort", "qc.bits", "c.primary", "c.secondary", "c.filter", "c.truncate", "c.annotations", "c.conditions", "c.name"])
    .where("qc.queue_id", "=", src.id)
    .where("qc.staff_id", "=", src.row.staff_id)
    .orderBy("qc.sort")
    .execute();
  if (!rows.length && src.id !== 1) {
    // CustomQueue::getColumns(): in mancanza di colonne si usa la coda "Open" come modello
    rows = await executor
      .selectFrom("queue_columns as qc")
      .innerJoin("queue_column as c", "c.id", "qc.column_id")
      .select(["c.id", "qc.heading", "qc.width", "qc.sort", "qc.bits", "c.primary", "c.secondary", "c.filter", "c.truncate", "c.annotations", "c.conditions", "c.name"])
      .where("qc.queue_id", "=", 1)
      .where("qc.staff_id", "=", 0)
      .orderBy("qc.sort")
      .execute();
  }
  return rows.map((r) => ({
    id: r.id,
    heading: r.heading ?? r.name,
    width: r.width,
    primary: r.primary,
    secondary: r.secondary,
    filter: r.filter,
    truncate: r.truncate,
    annotations: phpJsonDecode(r.annotations, []),
    conditions: phpJsonDecode(r.conditions, []),
    sortable: (r.bits & QueueColumn.SORTABLE) !== 0,
  }));
}

export async function queueColumns(queue: TicketQueue, executor: DbOrTx = db()): Promise<QueueColumnDef[]> {
  return loadColumnDefs(queue, executor);
}

export async function queueSorts(queue: TicketQueue, executor: DbOrTx = db()): Promise<QueueSortDef[]> {
  const src = queue.sortSource();
  const rows = await executor
    .selectFrom("queue_sorts as qs")
    .innerJoin("queue_sort as s", "s.id", "qs.sort_id")
    .select(["s.id", "s.name", "s.columns"])
    .where("qs.queue_id", "=", src.id)
    .orderBy("qs.sort")
    .execute();
  return rows.map((r) => ({ id: r.id, name: r.name, columns: parseSortColumns(r.columns) }));
}

function parseSortColumns(json: string | null): { path: string; desc: boolean }[] {
  return phpJsonDecode<string[]>(json, []).map((p) => (p.startsWith("-") ? { path: p.slice(1), desc: true } : { path: p, desc: false }));
}

export async function loadSort(id: number, executor: DbOrTx): Promise<QueueSortDef | null> {
  const r = await executor.selectFrom("queue_sort").select(["id", "name", "columns"]).where("id", "=", id).executeTakeFirst();
  return r ? { id: r.id, name: r.name, columns: parseSortColumns(r.columns) } : null;
}
