import "server-only";

import { sql } from "kysely";

import { table, type DbOrTx } from "../../db";
import type { MassResult } from "../admin/common";

/**
 * Log di sistema: scp/logs.php (elenco include/staff/syslogs.inc.php ed eliminazione con
 * DELETE … WHERE log_id IN (…)).
 */
export const LOG_TYPES = ["Error", "Warning", "Debug"] as const;
export const LOG_SORTS = { id: "log_id", title: "title", type: "log_type", ip: "ip_address", date: "created", created: "created", updated: "updated" } as const;

export interface LogFilter {
  type?: string;
  /** date "YYYY-MM-DD" (strtotime della pagina PHP, nel fuso del DB) */
  startDate?: string;
  endDate?: string;
  sort?: string;
  order?: string;
  page?: number;
  limit?: number;
}

export async function listLogs(executor: DbOrTx, f: LogFilter) {
  const type = LOG_TYPES.find((t) => t.toLowerCase() === (f.type ?? "").toLowerCase()) ?? null;
  let start = f.startDate && f.startDate.length >= 8 ? f.startDate : "";
  let end = f.endDate && f.endDate.length >= 8 ? f.endDate : "";
  const today = new Date().toISOString().slice(0, 10);
  let invalid = false;
  if ((start && start > today) || (start && end && start > end)) {
    invalid = true;
    start = end = "";
  }
  const sortKey = (f.sort ?? "").toLowerCase() as keyof typeof LOG_SORTS;
  const column = LOG_SORTS[sortKey] ?? "log_id";
  const order = (f.order ?? "").toUpperCase() === "ASC" ? "asc" : "desc";
  const limit = f.limit ?? 25;
  const page = Math.max(1, f.page ?? 1);
  let q = executor.selectFrom("syslog");
  if (type) q = q.where("log_type", "=", type);
  if (start) q = q.where("created", ">=", `${start} 00:00:00`);
  if (end) q = q.where("created", "<=", `${end} 00:00:00`);
  const total = Number((await q.select((eb) => eb.fn.countAll<number>().as("n")).executeTakeFirstOrThrow()).n);
  const rows = await q
    .selectAll()
    .orderBy(column, order)
    .limit(limit)
    .offset((page - 1) * limit)
    .execute();
  return { rows, total, page, limit, invalid, type };
}

/** scp/logs.php do=mass_process a=delete */
export async function deleteLogs(executor: DbOrTx, ids: number[]): Promise<MassResult> {
  if (!ids.length) return { ok: false, num: 0, error: "select_one" };
  const res = await sql`DELETE FROM ${table("syslog")} WHERE log_id IN (${sql.join(ids)})`.execute(executor);
  const num = Number(res.numAffectedRows ?? 0);
  return num ? { ok: true, num } : { ok: false, num: 0, error: "failed" };
}
