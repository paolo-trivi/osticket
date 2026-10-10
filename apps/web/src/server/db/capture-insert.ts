import { CompiledQuery, type InsertQueryNode, type ValueNode, type ValuesItemNode } from "kysely";

import type { ChangeEntry } from "../system/changes/types";
import { encodeRow, encodeValue, looselyStored, pick, rowKey, type CellValue, type RowImage } from "../system/changes/values";
import { CaptureFail, checkCount, identity, keysOf, quote, readByKeys, tableOf, updateEntry, type CaptureEnv, type Plan } from "./capture-util";
import type { TableKeys } from "./table-keys";

/**
 * Cattura delle righe di un INSERT (row-capture.ts): righe rilette per chiave (valori letterali della
 * query) o per insertId (AUTO_INCREMENT, verificate colonna per colonna); ON DUPLICATE KEY UPDATE,
 * REPLACE e INSERT IGNORE con le righe di ogni chiave univoca nota lette prima e dopo.
 */
type Cell = { lit: true; value: unknown } | { lit: false };

function rowsOf(node: InsertQueryNode): Cell[][] {
  if (!node.values) return [[]];
  if (node.values.kind !== "ValuesNode") throw new CaptureFail("insert_select", node.values.kind);
  return (node.values as unknown as { values: readonly ValuesItemNode[] }).values.map((item) =>
    item.kind === "PrimitiveValueListNode"
      ? item.values.map((value) => ({ lit: true as const, value }))
      : item.values.map((n) => (n.kind === "ValueNode" ? { lit: true as const, value: (n as ValueNode).value } : { lit: false as const })),
  );
}

export async function prepareInsert(env: CaptureEnv, node: InsertQueryNode): Promise<Plan> {
  const { name } = tableOf(node.into);
  const upsert = !!(node.onDuplicateKey || node.replace || node.orAction);
  if (!upsert && env.skipInsert(name)) return { finish: async () => [] };
  const rows = rowsOf(node);
  if (rows.length > env.budget) throw new CaptureFail("too_large", `${name}: ${rows.length} righe`);
  const columns = (node.columns ?? []).map((c) => c.column.name);
  const { keys, id } = await keysOf(env, name);
  /** valori letterali (non NULL) delle colonne date in una riga, altrimenti null */
  const tuple = (row: Cell[], cols: string[]): CellValue[] | null => {
    const out: CellValue[] = [];
    for (const c of cols) {
      const cell = row[columns.indexOf(c)];
      if (!cell?.lit || cell.value === null || cell.value === undefined) return null;
      out.push(encodeValue(cell.value, c));
    }
    return out;
  };
  if (upsert) return prepareUpsert(env, name, keys, id, rows, tuple);
  const idTuples = rows.map((r) => tuple(r, id));
  if (idTuples.every((t) => t !== null)) {
    return {
      async finish() {
        const after = await readByKeys(env, name, "*", id, idTuples as CellValue[][]);
        if (after.size !== rows.length) throw new CaptureFail("insert_mismatch", `${name}: ${after.size} righe su ${rows.length}`);
        return [...after.values()].map((r) => ({ table: name, pk: identity(r, id, name), before: null, after: encodeRow(r) }));
      },
    };
  }
  const ai = keys.autoInc;
  const auto = (r: Cell[]) => {
    const cell = r[columns.indexOf(ai ?? "")];
    return !cell || !cell.lit || cell.value === null || cell.value === undefined || cell.value === 0;
  };
  if (!ai || id.length !== 1 || id[0] !== ai || !rows.every(auto)) throw new CaptureFail("keys_unknown", name);
  return {
    async finish(result) {
      if (result.insertId === undefined) throw new CaptureFail("insert_mismatch", `${name}: insertId assente`);
      checkCount(result, rows.length, name);
      const first = BigInt(result.insertId);
      const last = first + BigInt(rows.length - 1);
      const text = `SELECT * FROM ${quote(name)} WHERE ${quote(ai)} BETWEEN ? AND ? ORDER BY ${quote(ai)}`;
      const read = (await env.exec(CompiledQuery.raw(text, [first.toString(), last.toString()]))).rows;
      // id consecutivi non garantiti (innodb_autoinc_lock_mode = 2 con inserimenti concorrenti): si
      // verifica che le righe del range siano quelle inserite, colonna per colonna
      const ok =
        read.length === rows.length &&
        read.every((r, i) => columns.every((c, j) => c === ai || !rows[i][j]?.lit || looselyStored((rows[i][j] as { value: unknown }).value, encodeValue(r[c], c))));
      if (!ok) throw new CaptureFail("insert_mismatch", `${name}: id non consecutivi`);
      return read.map((r) => ({ table: name, pk: identity(r, id, name), before: null, after: encodeRow(r) }));
    },
  };
}

/** ON DUPLICATE KEY UPDATE, REPLACE, INSERT IGNORE: righe di ogni chiave univoca nota, prima e dopo. */
async function prepareUpsert(env: CaptureEnv, name: string, keys: TableKeys, id: string[], rows: Cell[][], tuple: (row: Cell[], cols: string[]) => CellValue[] | null): Promise<Plan> {
  const keySets = [id, ...[keys.pk, ...keys.uniques].filter((k) => k.length && k.join() !== id.join())];
  const lookups = keySets.map((cols) => ({ cols, tuples: [] as CellValue[][] }));
  for (const r of rows) {
    let found = false;
    for (const l of lookups) {
      const t = tuple(r, l.cols);
      if (t) {
        l.tuples.push(t);
        found = true;
      }
    }
    if (!found) throw new CaptureFail("keys_unknown", name);
  }
  const read = async (forUpdate: boolean) => {
    const out = new Map<string, RowImage>();
    for (const l of lookups.filter((x) => x.tuples.length)) {
      for (const r of (await readByKeys(env, name, "*", l.cols, l.tuples, forUpdate)).values()) {
        const img = encodeRow(r);
        out.set(rowKey(identity(r, id, name), id), img);
      }
    }
    return out;
  };
  const before = await read(true);
  if (before.size > env.budget) throw new CaptureFail("too_large", `${name}: oltre ${env.budget} righe`);
  return {
    async finish() {
      const after = await read(false);
      const entries: ChangeEntry[] = [];
      for (const k of new Set([...before.keys(), ...after.keys()])) {
        const b = before.get(k);
        const a = after.get(k);
        const pk = pick((b ?? a)!, id);
        if (b && a) {
          const e = updateEntry(name, pk, b, a, Object.keys(a), keys, id);
          if (e) entries.push(e);
        } else entries.push({ table: name, pk, before: b ?? null, after: a ?? null });
      }
      return entries;
    },
  };
}
