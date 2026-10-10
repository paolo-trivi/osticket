import { CompiledQuery, type QueryResult } from "kysely";

/**
 * Chiavi di una tabella del DB osTicket lette da information_schema (per la cattura delle righe delle
 * modifiche admin, row-capture.ts): chiave primaria, altri indici univoci, colonna AUTO_INCREMENT e
 * colonne ON UPDATE. Cache per processo: TailTicket non modifica mai lo schema.
 */
export interface TableKeys {
  pk: string[];
  uniques: string[][];
  autoInc: string | null;
  onUpdate: string[];
}

export type Exec = (q: CompiledQuery) => Promise<QueryResult<Record<string, unknown>>>;

const g = globalThis as typeof globalThis & { __ttTableKeys?: Map<string, TableKeys> };
const cache = (g.__ttTableKeys ??= new Map<string, TableKeys>());

const INDEX_SQL =
  "SELECT INDEX_NAME AS idx, COLUMN_NAME AS col FROM information_schema.STATISTICS " +
  "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND NON_UNIQUE = 0 ORDER BY INDEX_NAME, SEQ_IN_INDEX";
const COLUMN_SQL = "SELECT COLUMN_NAME AS col, EXTRA AS extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?";

export async function tableKeys(exec: Exec, table: string): Promise<TableKeys> {
  const hit = cache.get(table);
  if (hit) return hit;
  const idx = await exec(CompiledQuery.raw(INDEX_SQL, [table]));
  const cols = await exec(CompiledQuery.raw(COLUMN_SQL, [table]));
  const byIndex = new Map<string, string[]>();
  for (const r of idx.rows) {
    const name = String(r.idx);
    byIndex.set(name, [...(byIndex.get(name) ?? []), String(r.col)]);
  }
  const extra = cols.rows.map((r) => ({ col: String(r.col), extra: String(r.extra ?? "").toLowerCase() }));
  const keys: TableKeys = {
    pk: byIndex.get("PRIMARY") ?? [],
    uniques: [...byIndex].filter(([n]) => n !== "PRIMARY").map(([, c]) => c),
    autoInc: extra.find((c) => c.extra.includes("auto_increment"))?.col ?? null,
    onUpdate: extra.filter((c) => c.extra.includes("on update")).map((c) => c.col),
  };
  // tabella inesistente (nessuna colonna): non si mette in cache
  if (extra.length) cache.set(table, keys);
  return keys;
}

/** Colonne che identificano una riga: chiave primaria, altrimenti il primo indice univoco. */
export function identityOf(k: TableKeys): string[] {
  return k.pk.length ? k.pk : (k.uniques[0] ?? []);
}

/** Solo per i test. */
export function clearTableKeysForTests(): void {
  cache.clear();
}
