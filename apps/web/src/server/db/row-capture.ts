import {
  ColumnNode,
  createQueryId,
  FromNode,
  LimitNode,
  SelectionNode,
  SelectModifierNode,
  ValueNode,
  type ColumnUpdateNode,
  type CompiledQuery,
  type DeleteQueryNode,
  type InsertQueryNode,
  type OperationNode,
  type QueryResult,
  type ReferenceNode,
  type SelectQueryNode,
  type UpdateQueryNode,
} from "kysely";

import type { NotUndoableReason } from "@/lib/changes";

import type { ChangeEntry } from "../system/changes/types";
import { encodeRow, rowKey, UnsupportedValueError } from "../system/changes/values";
import { prepareInsert } from "./capture-insert";
import { CaptureFail, checkCount, identity, keysOf, readByKeys, tableOf, uniq, updateEntry, type CaptureEnv, type Plan } from "./capture-util";

/**
 * Cattura delle righe toccate da una scrittura (before/after image) per l'annullamento delle modifiche
 * admin. Lavora sul nodo Kysely della query già compilata, sulla stessa connessione (e transazione):
 *  - UPDATE/DELETE: prima della query una SELECT … FOR UPDATE con lo stesso WHERE (e ORDER BY/LIMIT),
 *    compilata dal compilatore del dialetto; dopo l'UPDATE le righe si rileggono per chiave primaria;
 *  - INSERT: righe inserite rilette per chiave (valori della query) o per insertId (AUTO_INCREMENT);
 *    ON DUPLICATE KEY UPDATE / REPLACE / IGNORE: righe esistenti lette prima per chiave univoca.
 * Tutto ciò che non si può catturare con certezza (SQL scritto a mano, più tabelle, chiavi ignote,
 * troppe righe…) è un CaptureFail: la modifica resta valida ma non annullabile.
 */
type CaptureOutcome = { entries: ChangeEntry[] } | { fail: NotUndoableReason; detail: string };

/** Esegue la scrittura (`run`) catturandone le righe; la scrittura parte comunque, anche se non catturabile. */
export async function captureWrite<R>(env: CaptureEnv, q: CompiledQuery, verb: string, run: () => Promise<QueryResult<R>>): Promise<{ result: QueryResult<R>; outcome: CaptureOutcome }> {
  let plan: Plan;
  try {
    plan = await prepare(env, q.query as OperationNode | undefined, verb);
  } catch (err) {
    return { result: await run(), outcome: failOf(err) };
  }
  const result = await run();
  try {
    return { result, outcome: { entries: await plan.finish(result as QueryResult<unknown>) } };
  } catch (err) {
    return { result, outcome: failOf(err) };
  }
}

function failOf(err: unknown): CaptureOutcome {
  if (err instanceof CaptureFail) return { fail: err.reason, detail: err.detail };
  if (err instanceof UnsupportedValueError) return { fail: "unsupported_value", detail: err.message };
  return { fail: "capture_failed", detail: String((err as Error)?.message ?? err).slice(0, 200) };
}

async function prepare(env: CaptureEnv, node: OperationNode | undefined, verb: string): Promise<Plan> {
  if (!node || node.kind === "RawNode") throw new CaptureFail("raw_sql", verb);
  if (node.kind === "UpdateQueryNode") return prepareUpdate(env, node as UpdateQueryNode);
  if (node.kind === "DeleteQueryNode") return prepareDelete(env, node as DeleteQueryNode);
  if (node.kind === "InsertQueryNode") return prepareInsert(env, node as InsertQueryNode);
  throw new CaptureFail("unsupported_write", node.kind);
}

function columnOf(n: OperationNode): string {
  if (n.kind === "ColumnNode") return (n as ColumnNode).column.name;
  if (n.kind === "ReferenceNode" && (n as ReferenceNode).column.kind === "ColumnNode") return ((n as ReferenceNode).column as ColumnNode).column.name;
  throw new CaptureFail("unsupported_write", `colonna ${n.kind}`);
}

// ── UPDATE / DELETE ──────────────────────────────────────────────────────────────────────────────────

function beforeSelect(env: CaptureEnv, source: OperationNode, selections: SelectionNode[], node: UpdateQueryNode | DeleteQueryNode): CompiledQuery {
  const select: SelectQueryNode = {
    kind: "SelectQueryNode",
    from: FromNode.create([source]),
    selections,
    ...(node.where && { where: node.where }),
    ...(node.with && { with: node.with }),
    ...(node.orderBy && { orderBy: node.orderBy }),
    limit: node.limit ?? LimitNode.create(ValueNode.createImmediate(env.budget + 1)),
    endModifiers: [SelectModifierNode.create("ForUpdate")],
  };
  return env.compiler.compileQuery(select, createQueryId());
}

async function prepareUpdate(env: CaptureEnv, node: UpdateQueryNode): Promise<Plan> {
  if (node.from || node.joins?.length) throw new CaptureFail("multi_table", "UPDATE con JOIN/FROM");
  const { name, source } = tableOf(node.table);
  if (node.limit && !node.orderBy) throw new CaptureFail("limit_without_order", name);
  const { keys, id } = await keysOf(env, name);
  const set = (node.updates ?? []).map((u: ColumnUpdateNode) => columnOf(u.column));
  if (set.some((c) => id.includes(c))) throw new CaptureFail("pk_update", name);
  const cols = uniq([...id, ...set, ...keys.onUpdate]);
  const before = (
    await env.exec(
      beforeSelect(
        env,
        source,
        cols.map((c) => SelectionNode.create(ColumnNode.create(c))),
        node,
      ),
    )
  ).rows;
  if (before.length > env.budget) throw new CaptureFail("too_large", `${name}: oltre ${env.budget} righe`);
  return {
    async finish(result) {
      if (!before.length) return [];
      checkCount(result, before.length, name);
      const pks = before.map((r) => identity(r, id, name));
      const after = await readByKeys(
        env,
        name,
        cols,
        id,
        pks.map((pk) => id.map((c) => pk[c])),
      );
      const entries: ChangeEntry[] = [];
      before.forEach((b, i) => {
        const a = after.get(rowKey(pks[i], id));
        if (!a) throw new CaptureFail("capture_failed", `${name}: riga non trovata dopo l'UPDATE`);
        const e = updateEntry(name, pks[i], encodeRow(b, cols), encodeRow(a, cols), cols, keys, id);
        if (e) entries.push(e);
      });
      return entries;
    },
  };
}

async function prepareDelete(env: CaptureEnv, node: DeleteQueryNode): Promise<Plan> {
  if (node.from.froms.length !== 1 || node.using || node.joins?.length) throw new CaptureFail("multi_table", "DELETE con JOIN/USING");
  const { name, source } = tableOf(node.from.froms[0]);
  if (node.limit && !node.orderBy) throw new CaptureFail("limit_without_order", name);
  const { id } = await keysOf(env, name);
  const before = (await env.exec(beforeSelect(env, source, [SelectionNode.createSelectAll()], node))).rows;
  if (before.length > env.budget) throw new CaptureFail("too_large", `${name}: oltre ${env.budget} righe`);
  const entries = before.map((r) => ({ table: name, pk: identity(r, id, name), before: encodeRow(r), after: null }));
  return {
    async finish(result) {
      if (entries.length) checkCount(result, entries.length, name);
      return entries;
    },
  };
}
