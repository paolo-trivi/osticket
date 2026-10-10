/**
 * Annullamento delle modifiche dell'area admin: tipi condivisi tra server e interfaccia (nessun valore
 * delle righe, solo il riepilogo). La registrazione è in src/server/system/changes/.
 */

/** Motivi per cui una modifica non si può annullare (chiavi di admChanges.reasons). */
export const NOT_UNDOABLE_REASONS = [
  "raw_sql",
  "multi_table",
  "no_key",
  "limit_without_order",
  "pk_update",
  "insert_select",
  "keys_unknown",
  "insert_mismatch",
  "too_large",
  "stream",
  "savepoint",
  "capture_failed",
  "unsupported_value",
  "unsupported_write",
  "store_failed",
] as const;
export type NotUndoableReason = (typeof NOT_UNDOABLE_REASONS)[number];

/** Righe al massimo in una modifica annullabile: oltre, la modifica resta registrata ma non annullabile. */
export const MAX_CHANGE_ROWS = 5000;

/** Riferimento a una modifica registrata, restituito dai salvataggi admin all'interfaccia. */
export interface ChangeRef {
  id: string;
  undoable: boolean;
  reason?: NotUndoableReason;
  rows: number;
}

/** Errori dell'annullamento (chiavi di admChanges.errors). */
export type UndoError = "not_found" | "not_undoable" | "already_undone" | "read_only" | "schema_mismatch" | "prefix_mismatch" | "conflict" | "disabled" | "busy" | "failed";

/** Esito dell'annullamento per l'interfaccia: le righe in conflitto come "tabella id=…" (mai i valori delle colonne). */
export type UndoState = { status: "done"; change: ChangeRef | null } | { status: "error"; error: UndoError; conflicts?: string[] };

/** Formato degli id delle modifiche (anche nome dei file): YYYYMMDD-HHMMSS-xxxx (UTC). */
export const CHANGE_ID_RE = /^\d{8}-\d{6}-[0-9a-f]{4}$/;
