import "server-only";

import { NOW, type DbOrTx } from "../../db";
import { phpLooseEquals } from "../../php/values";

/**
 * Config di osTicket (include/class.config.php) in scrittura, per un namespace:
 * - il costruttore carica tutte le chiavi del namespace;
 * - update($key, $value): INSERT se la chiave non esiste (ConfigItem nuovo, `updated = NOW()`),
 *   altrimenti UPDATE solo se il valore cambia con confronto
 *   debole, con `updated = NOW()` (ConfigItem::save);
 * - updateAll($updates): si ferma al primo update fallito (solo errori SQL).
 * I valori booleani sono scritti come 1/0 (bind "i" di mysqli), i NULL in UPDATE diventano ''.
 */
export type ConfigValue = string | number | boolean | null | undefined;

export class ConfigWriter {
  private constructor(
    readonly namespace: string,
    private readonly items: Map<string, { id: number; value: string | null }>,
  ) {}

  static async load(executor: DbOrTx, namespace: string): Promise<ConfigWriter> {
    const rows = await executor.selectFrom("config").select(["id", "key", "value"]).where("namespace", "=", namespace).execute();
    return new ConfigWriter(namespace, new Map(rows.map((r) => [r.key, { id: r.id, value: r.value }])));
  }

  get(key: string): string | null | undefined {
    return this.items.get(key)?.value;
  }

  has(key: string): boolean {
    return this.items.has(key);
  }

  /** Config::update($key, $value) */
  async update(executor: DbOrTx, key: string, value: ConfigValue): Promise<boolean> {
    if (!key) return false;
    const v = value === undefined ? null : value;
    const bound = typeof v === "boolean" ? (v ? 1 : 0) : v;
    const item = this.items.get(key);
    if (!item) {
      // new ConfigItem([...]): un valore "uguale a NULL" (null, false, 0, "") non è dirty e la
      // colonna NOT NULL prende il default implicito ''
      const value = phpLooseEquals(null, v) ? "" : String(bound);
      const res = await executor.insertInto("config").values({ namespace: this.namespace, key, value, updated: NOW } as never).executeTakeFirst();
      this.items.set(key, { id: Number(res.insertId), value });
      return true;
    }
    if (phpLooseEquals(item.value, v)) return true;
    const stored = bound === null ? "" : String(bound);
    await executor.updateTable("config").set({ value: stored, updated: NOW }).where("id", "=", item.id).execute();
    item.value = stored;
    return true;
  }

  /** Config::updateAll($updates) */
  async updateAll(executor: DbOrTx, updates: Record<string, ConfigValue>): Promise<boolean> {
    for (const [k, v] of Object.entries(updates)) if (!(await this.update(executor, k, v))) return false;
    return true;
  }
}
