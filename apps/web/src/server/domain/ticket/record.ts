import "server-only";

import { NOW, type DbOrTx } from "../../db";
import type { TicketTable } from "../../db/schema.gen";
import { phpLooseEquals } from "../../php/values";
import { reindexTicket } from "../search/index-writer";

export { phpLooseEquals };

/**
 * Riga `ticket` con la semantica di VerySimpleModel (include/class.orm.php):
 * - set() marca un campo "dirty" solo se il valore cambia con confronto debole (`$old != $value`);
 * - save() scrive solo i campi dirty e, per i ticket, imposta `updated = NOW()` (Ticket::save);
 * - NOW() è sempre una modifica (SqlFunction non è mai uguale al valore precedente).
 */
export const SQL_NOW = Symbol("NOW");
type Value = string | number | null | typeof SQL_NOW;

export type TicketColumns = {
  ticket_id: number;
  ticket_pid: number | null;
  number: string;
  user_id: number;
  user_email_id: number;
  status_id: number;
  dept_id: number;
  sla_id: number;
  topic_id: number;
  staff_id: number;
  team_id: number;
  email_id: number;
  lock_id: number;
  flags: number;
  sort: number;
  ip_address: string;
  source: string;
  source_extra: string | null;
  isoverdue: number;
  isanswered: number;
  duedate: string | null;
  est_duedate: string | null;
  reopened: string | null;
  closed: string | null;
  lastupdate: string | null;
  created: string;
  updated: string;
};

export class TicketRecord {
  private readonly dirty = new Set<keyof TicketColumns>();

  private constructor(
    private readonly executor: DbOrTx,
    public row: TicketColumns,
  ) {}

  static async load(executor: DbOrTx, ticketId: number, forUpdate = false): Promise<TicketRecord | null> {
    let q = executor.selectFrom("ticket").selectAll().where("ticket_id", "=", ticketId);
    if (forUpdate) q = q.forUpdate();
    const row = await q.executeTakeFirst();
    return row ? new TicketRecord(executor, row as unknown as TicketColumns) : null;
  }

  get id(): number {
    return this.row.ticket_id;
  }

  get<K extends keyof TicketColumns>(k: K): TicketColumns[K] {
    return this.row[k];
  }

  set<K extends keyof TicketColumns>(k: K, value: TicketColumns[K] | typeof SQL_NOW): void {
    const old = this.row[k];
    if (value === SQL_NOW || !phpLooseEquals(old, value)) this.dirty.add(k);
    (this.row as Record<string, Value>)[k] = value as Value;
  }

  isDirty(): boolean {
    return this.dirty.size > 0;
  }

  /** Ticket::save($refetch): scrive i campi modificati più `updated = NOW()`, poi rilegge la riga. */
  async save(refetch = false): Promise<void> {
    if (this.dirty.size) {
      this.set("updated", SQL_NOW as never);
      const values: Record<string, unknown> = {};
      for (const k of this.dirty) {
        const v = (this.row as Record<string, Value>)[k];
        values[k] = v === SQL_NOW ? NOW : v;
      }
      await this.executor
        .updateTable("ticket")
        .set(values as Partial<Record<keyof TicketTable, never>>)
        .where("ticket_id", "=", this.row.ticket_id)
        .execute();
      this.dirty.clear();
      await this.reload();
      // Signal model.updated → MysqlSearchBackend reindicizza il ticket
      await reindexTicket(this.executor, this.row.ticket_id);
    } else if (refetch) {
      await this.reload();
    }
  }

  async reload(): Promise<void> {
    const row = await this.executor.selectFrom("ticket").selectAll().where("ticket_id", "=", this.row.ticket_id).executeTakeFirst();
    if (row) this.row = row as unknown as TicketColumns;
  }
}

/** Stato (open/closed/archived/deleted) di uno status id. */
export async function statusState(executor: DbOrTx, statusId: number): Promise<string | null> {
  const r = await executor.selectFrom("ticket_status").select("state").where("id", "=", statusId).executeTakeFirst();
  return r?.state ?? null;
}

