import "server-only";

import { sql, type ExpressionBuilder, type Kysely } from "kysely";

import type { ChangeRef, UndoError } from "@/lib/changes";

import { db, type DbOrTx } from "../../db";
import { installConfig } from "../../env";
import { schemaStatus } from "../schema-compat";
import { canWrite, isReadOnlyError, withWriteScope } from "../write-mode";
import { withChangeset } from "./changeset";
import { findConflicts, restoreOps, touchedRows, entryKey, type Conflict, type CurrentRows, type RestoreOp } from "./plan";
import { changesEnabled, loadChangeset, loadSummary, updateSummary } from "./store";
import type { Changeset, ChangeSummary, StaffRef } from "./types";
import { decodeRow, decodeValue, encodeRow, type RowImage } from "./values";

/**
 * Annullamento di una modifica dell'area admin (changeset): in una sola transazione, nello scope di
 * scrittura "restore" (write-mode.ts: modalità configurata full e schema verificato, anche con il doctor
 * in errore). Prima i conflitti (righe cambiate dopo la modifica): senza `force` (solo dal CLI) nessuna
 * scrittura. Firma dello schema e prefisso devono essere quelli della modifica. L'annullamento è a sua
 * volta una modifica registrata (annullabile: "rifai") e passa dal registro delle scritture.
 */
type UndoResult = { ok: true; change: ChangeRef | null; skipped: number } | { ok: false; error: UndoError; conflicts?: Conflict[]; reason?: string };

export interface UndoPreview {
  summary: ChangeSummary;
  /** null: annullabile senza conflitti; altrimenti il motivo */
  error: UndoError | null;
  conflicts: Conflict[];
}

const CHUNK = 500;
const g = globalThis as typeof globalThis & { __ttUndoBusy?: Set<string> };
const busy = (g.__ttUndoBusy ??= new Set<string>());

class ConflictAbort extends Error {
  constructor(readonly conflicts: Conflict[]) {
    super("conflitti");
  }
}

/** Righe attuali delle righe toccate dalla modifica (FOR UPDATE dentro la transazione dell'annullamento). */
async function readCurrent(executor: DbOrTx, cs: Changeset, forUpdate: boolean): Promise<CurrentRows> {
  const current: CurrentRows = new Map();
  const byTable = new Map<string, RowImage[]>();
  for (const r of touchedRows(cs.entries)) byTable.set(r.table, [...(byTable.get(r.table) ?? []), r.pk]);
  for (const [table, pks] of byTable) {
    const cols = Object.keys(pks[0]);
    for (let i = 0; i < pks.length; i += CHUNK) {
      const part = pks.slice(i, i + CHUNK);
      const tuples = part.map((pk) => sql`(${sql.join(cols.map((c) => decodeValue(pk[c])))})`);
      const res = await sql<
        Record<string, unknown>
      >`SELECT * FROM ${sql.table(table)} WHERE (${sql.join(cols.map((c) => sql.ref(c)))}) IN (${sql.join(tuples)})${forUpdate ? sql` FOR UPDATE` : sql``}`.execute(executor);
      for (const row of res.rows) current.set(entryKey(table, encodeRow(row, cols)), encodeRow(row));
    }
    for (const pk of pks) if (!current.has(entryKey(table, pk))) current.set(entryKey(table, pk), null);
  }
  return current;
}

/** Tabelle con il nome reale (prefisso compreso), fuori dai tipi di DB. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = Kysely<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const byPk = (pk: RowImage) => (eb: ExpressionBuilder<any, any>) => eb.and(Object.entries(pk).map(([c, v]) => eb(c, "=", decodeValue(v))));

/** Scritture con il query builder: catturate a loro volta (l'annullamento è una modifica annullabile). */
export async function applyRestoreOp(executor: DbOrTx, op: RestoreOp): Promise<void> {
  const k = executor as unknown as AnyDb;
  if (op.kind === "delete") await k.deleteFrom(op.table).where(byPk(op.pk)).execute();
  else if (op.kind === "insert") await k.insertInto(op.table).values(decodeRow(op.row)).execute();
  else if (Object.keys(op.set).length) await k.updateTable(op.table).set(decodeRow(op.set)).where(byPk(op.pk)).execute();
}

/** Controlli comuni ad anteprima e annullamento (senza leggere il DB). */
async function precheck(id: string): Promise<{ cs: Changeset; summary: ChangeSummary } | { error: UndoError; summary?: ChangeSummary }> {
  if (!changesEnabled()) return { error: "disabled" };
  const [summary, cs] = await Promise.all([loadSummary(id), loadChangeset(id)]);
  if (!summary || !cs) return { error: "not_found" };
  if (summary.undone) return { error: "already_undone", summary };
  if (!cs.undoable || !cs.entries.length) return { error: "not_undoable", summary };
  const { loadConfigNamespace } = await import("../../config/config");
  if (schemaStatus(await loadConfigNamespace("core")).signature !== cs.schema_signature) return { error: "schema_mismatch", summary };
  if (installConfig().tablePrefix !== cs.prefix) return { error: "prefix_mismatch", summary };
  return { cs, summary };
}

/** Stato di una modifica per l'elenco e per il CLI: annullabile, conflitti o motivo (sola lettura). */
export async function previewUndo(id: string): Promise<UndoPreview | null> {
  const pre = await precheck(id);
  if ("error" in pre) return pre.summary ? { summary: pre.summary, error: pre.error, conflicts: [] } : null;
  const conflicts = findConflicts(pre.cs.entries, await readCurrent(db(), pre.cs, false));
  return { summary: pre.summary, error: conflicts.length ? "conflict" : null, conflicts };
}

export async function undoChange(id: string, opts: { staff: StaffRef | null; force?: boolean; path?: string }): Promise<UndoResult> {
  if (busy.has(id)) return { ok: false, error: "busy" };
  busy.add(id);
  try {
    const pre = await precheck(id);
    if ("error" in pre) return { ok: false, error: pre.error, reason: pre.summary?.reason };
    if (!(await canWrite("restore"))) return { ok: false, error: "read_only" };
    const { cs } = pre;
    let skipped = 0;
    const op = `undo:${id}`;
    const { change } = await withChangeset({ staff: opts.staff, op, path: opts.path, undoes: id }, () =>
      withWriteScope(
        "restore",
        () =>
          db()
            .transaction()
            .execute(async (tx) => {
              const current = await readCurrent(tx, cs, true);
              const conflicts = findConflicts(cs.entries, current);
              if (conflicts.length && !opts.force) throw new ConflictAbort(conflicts);
              const plan = restoreOps(cs.entries, current);
              skipped = plan.skipped;
              for (const o of plan.ops) await applyRestoreOp(tx, o);
            }),
        { op, actor: opts.staff ? { type: "agent", id: opts.staff.id } : { type: "system" } },
      ),
    );
    const ts = new Date().toISOString();
    await updateSummary(id, (s) => ({ ...s, undone: { by: change?.id ?? "", ts } }));
    // annullare un annullamento ("rifai") rende di nuovo annullabile la modifica originale
    if (cs.undoes) await updateSummary(cs.undoes, ({ undone, ...s }) => (void undone, s));
    return { ok: true, change, skipped };
  } catch (err) {
    if (err instanceof ConflictAbort) return { ok: false, error: "conflict", conflicts: err.conflicts };
    if (isReadOnlyError(err)) return { ok: false, error: "read_only" };
    throw err;
  } finally {
    busy.delete(id);
  }
}

/** Ultima modifica non annullata che non sia a sua volta un annullamento (`./tailticket undo last`). */
export function lastUndoable(list: readonly ChangeSummary[]): ChangeSummary | undefined {
  return list.find((s) => !s.undone && !s.undoes);
}
