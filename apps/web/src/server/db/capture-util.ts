import { CompiledQuery, type AliasNode, type OperationNode, type QueryCompiler, type QueryResult, type TableNode } from "kysely";

import type { NotUndoableReason } from "@/lib/changes";

import type { ChangeEntry } from "../system/changes/types";
import { decodeValue, encodeRow, pick, rowKey, sameCell, type CellValue, type RowImage } from "../system/changes/values";
import { identityOf, tableKeys, type Exec, type TableKeys } from "./table-keys";

/** Strumenti comuni della cattura delle righe (row-capture.ts, capture-insert.ts). */
export interface CaptureEnv {
  exec: Exec;
  compiler: QueryCompiler;
  /** righe ancora registrabili nella modifica */
  budget: number;
  /** INSERT da non registrare (tabelle di log) */
  skipInsert: (table: string) => boolean;
}

export class CaptureFail extends Error {
  constructor(
    readonly reason: NotUndoableReason,
    readonly detail: string,
  ) {
    super(`${reason}: ${detail}`);
  }
}

export interface Plan {
  finish(result: QueryResult<unknown>): Promise<ChangeEntry[]>;
}

export const quote = (id: string) => "`" + id.replace(/`/g, "``") + "`";
export const uniq = (a: string[]) => [...new Set(a)];
const CHUNK = 500;

export function tableOf(n: OperationNode | undefined): { name: string; source: OperationNode } {
  const t = n?.kind === "AliasNode" ? (n as AliasNode).node : n;
  if (t?.kind !== "TableNode") throw new CaptureFail("multi_table", n?.kind ?? "?");
  const id = (t as TableNode).table;
  if (id.schema) throw new CaptureFail("multi_table", `${id.schema.name}.${id.identifier.name}`);
  return { name: id.identifier.name, source: n! };
}

export async function keysOf(env: CaptureEnv, table: string): Promise<{ keys: TableKeys; id: string[] }> {
  const keys = await tableKeys(env.exec, table);
  const id = identityOf(keys);
  if (!id.length) throw new CaptureFail("no_key", table);
  return { keys, id };
}

export function identity(row: Record<string, unknown>, id: string[], table: string): RowImage {
  const pk = encodeRow(row, id);
  if (id.some((c) => pk[c] === null)) throw new CaptureFail("no_key", `${table}: chiave NULL`);
  return pk;
}

export function checkCount(result: QueryResult<unknown>, expected: number, table: string): void {
  const n = result.numAffectedRows;
  if (n !== undefined && Number(n) !== expected) throw new CaptureFail("capture_failed", `${table}: ${n} righe invece di ${expected}`);
}

/** SELECT delle righe con le chiavi date ((a, b) IN ((?, ?), …)), a blocchi; mappa chiave → riga. */
export async function readByKeys(
  env: CaptureEnv,
  table: string,
  cols: string[] | "*",
  keyCols: string[],
  tuples: CellValue[][],
  forUpdate = false,
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  const sel = cols === "*" ? "*" : cols.map(quote).join(", ");
  const lhs = keyCols.length === 1 ? quote(keyCols[0]) : `(${keyCols.map(quote).join(", ")})`;
  const one = keyCols.length === 1 ? "?" : `(${keyCols.map(() => "?").join(", ")})`;
  for (let i = 0; i < tuples.length; i += CHUNK) {
    const part = tuples.slice(i, i + CHUNK);
    const text = `SELECT ${sel} FROM ${quote(table)} WHERE ${lhs} IN (${part.map(() => one).join(", ")})${forUpdate ? " FOR UPDATE" : ""}`;
    const res = await env.exec(CompiledQuery.raw(text, part.flat().map(decodeValue)));
    for (const r of res.rows) out.set(rowKey(encodeRow(r, keyCols), keyCols), r);
  }
  return out;
}

/** Voce di UPDATE con le sole colonne cambiate (più le ON UPDATE); null se la riga non è cambiata. */
export function updateEntry(table: string, pk: RowImage, before: RowImage, after: RowImage, cols: string[], keys: TableKeys, id: string[]): ChangeEntry | null {
  const changed = cols.filter((c) => !id.includes(c) && !sameCell(before[c], after[c]));
  if (!changed.length) return null;
  const keep = uniq([...changed, ...keys.onUpdate.filter((c) => c in before || c in after)]);
  return { table, pk, before: pick(before, keep), after: pick(after, keep) };
}
