import "server-only";

import type { DB } from "../../db/schema.gen";
import { NOW, type DbOrTx } from "../../db";
import { phpLooseEquals } from "../ticket/record";

/**
 * Riga di un modello VerySimpleModel (include/class.orm.php) con la stessa semantica di scrittura:
 * - set() marca un campo "dirty" solo se cambia con confronto debole (`$old != $value`); NOW() è
 *   sempre una modifica;
 * - save() fa INSERT con i soli campi impostati (gli altri prendono il default della colonna) oppure
 *   UPDATE dei soli campi dirty (… WHERE pk LIMIT 1);
 * - `touchUpdated`: i save() dei modelli admin (Dept, Topic, SLA, Team, Staff, Role, Schedule…)
 *   impostano `updated = NOW()` quando c'è almeno un campo modificato.
 */
export const SQL_NOW = Symbol("NOW");
export type OrmValue = string | number | boolean | null | typeof SQL_NOW;

type TableName = keyof DB;

export class OrmRow {
  readonly dirty = new Set<string>();
  private constructor(
    readonly table: TableName,
    readonly pk: string[],
    public ht: Record<string, OrmValue>,
    public isNew: boolean,
    readonly touchUpdated: boolean,
  ) {}

  static create(table: TableName, pk: string | string[], opts: { touchUpdated?: boolean } = {}): OrmRow {
    return new OrmRow(table, Array.isArray(pk) ? pk : [pk], {}, true, opts.touchUpdated ?? false);
  }

  static from(table: TableName, pk: string | string[], row: Record<string, unknown>, opts: { touchUpdated?: boolean } = {}): OrmRow {
    return new OrmRow(table, Array.isArray(pk) ? pk : [pk], { ...(row as Record<string, OrmValue>) }, false, opts.touchUpdated ?? false);
  }

  static async load(executor: DbOrTx, table: TableName, pk: string | string[], where: Record<string, unknown>, opts: { touchUpdated?: boolean } = {}): Promise<OrmRow | null> {
    let q = executor.selectFrom(table).selectAll() as unknown as {
      where: (c: string, o: string, v: unknown) => typeof q;
      executeTakeFirst: () => Promise<Record<string, unknown> | undefined>;
    };
    for (const [k, v] of Object.entries(where)) q = q.where(k, "=", v);
    const row = await q.executeTakeFirst();
    return row ? OrmRow.from(table, pk, row, opts) : null;
  }

  get(k: string): OrmValue {
    return this.ht[k] ?? null;
  }

  num(k: string): number {
    const v = this.ht[k];
    return typeof v === "number" ? v : Number(v ?? 0) || 0;
  }

  set(k: string, value: OrmValue): void {
    const old = this.ht[k];
    if (value === SQL_NOW || old === SQL_NOW || !phpLooseEquals(old ?? null, value)) this.dirty.add(k);
    this.ht[k] = value;
  }

  isDirty(): boolean {
    return this.dirty.size > 0;
  }

  /** save(): INSERT (nuovo) o UPDATE dei campi modificati. Restituisce false se non c'era nulla da salvare. */
  async save(executor: DbOrTx): Promise<boolean> {
    if (!this.dirty.size) return true;
    if (this.touchUpdated) this.set("updated", SQL_NOW);
    const values: Record<string, unknown> = {};
    for (const k of this.dirty) {
      if (!this.isNew && this.pk.includes(k)) continue;
      const v = this.ht[k];
      values[k] = v === SQL_NOW ? NOW : typeof v === "boolean" ? (v ? 1 : 0) : v;
    }
    const t = this.table as never;
    if (this.isNew) {
      const res = await executor.insertInto(t).values(values as never).executeTakeFirst();
      if (this.pk.length === 1 && this.ht[this.pk[0]] == null) this.ht[this.pk[0]] = Number(res.insertId);
      this.isNew = false;
    } else {
      let q = executor.updateTable(t).set(values as never) as unknown as { where: (c: string, o: string, v: unknown) => typeof q; execute: () => Promise<unknown> };
      for (const k of this.pk) q = q.where(k, "=", this.ht[k]);
      await q.execute();
    }
    // i valori NOW() restano "simbolici" in memoria come l'oggetto SqlFunction del PHP
    this.dirty.clear();
    return true;
  }

  async delete(executor: DbOrTx): Promise<void> {
    let q = executor.deleteFrom(this.table as never) as unknown as { where: (c: string, o: string, v: unknown) => typeof q; execute: () => Promise<unknown> };
    for (const k of this.pk) q = q.where(k, "=", this.ht[k]);
    await q.execute();
  }
}

/** setFlag($flag, $val) dei modelli: flags |= flag oppure flags &= ~flag. */
export function setFlag(row: OrmRow, flag: number, on: boolean, col = "flags"): void {
  const cur = row.num(col);
  row.set(col, on ? cur | flag : cur & ~flag);
}
