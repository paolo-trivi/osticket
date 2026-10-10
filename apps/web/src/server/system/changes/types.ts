import type { NotUndoableReason } from "@/lib/changes";

import type { RowImage } from "./values";

/**
 * Changeset: una operazione dell'area admin (un'invocazione di adminWrite, anche su più transazioni) con
 * le righe toccate, nell'ordine di conferma. Per ogni riga:
 *  - INSERT: before null, after = riga intera;
 *  - DELETE: before = riga intera, after null;
 *  - UPDATE: before/after con le sole colonne cambiate (più quelle ON UPDATE della tabella).
 * `table` è il nome reale (con il prefisso), `pk` le colonne della chiave primaria (o del primo indice
 * univoco se la tabella non ha chiave primaria).
 */
export interface ChangeEntry {
  table: string;
  pk: RowImage;
  before: RowImage | null;
  after: RowImage | null;
}

export interface StaffRef {
  id: number;
  username: string;
}

interface ChangesetHead {
  id: string;
  /** fine dell'operazione, ISO 8601 UTC */
  ts: string;
  /** agente della sessione; null per il CLI */
  staff: StaffRef | null;
  /** operazione (es. "admin.theme", "undo:<id>", "action:<id>") */
  op: string | null;
  /** pagina da cui è partita la modifica (percorso del Referer), "cli" per ./tailticket undo */
  path: string | null;
  schema_signature: string;
  prefix: string;
  undoable: boolean;
  reason?: NotUndoableReason;
  /** dettaglio tecnico del motivo (tabella, verbo): mai valori delle righe */
  detail?: string;
  /** id della modifica annullata da questa (annullamento) */
  undoes?: string;
}

export interface Changeset extends ChangesetHead {
  v: 1;
  /** tabelle reali → verbi SQL, anche delle scritture non registrabili */
  touched: Record<string, string[]>;
  /** vuoto se la modifica non è annullabile (i valori non si conservano) */
  entries: ChangeEntry[];
}

export interface TableCounts {
  insert: number;
  update: number;
  delete: number;
}

/** Riepilogo senza valori (file .meta.json): elenco, interfaccia e CLI. */
export interface ChangeSummary extends ChangesetHead {
  rows: number;
  tables: Record<string, TableCounts>;
  touched: Record<string, string[]>;
  undone?: { by: string; ts: string };
}

export function entryKind(e: ChangeEntry): keyof TableCounts {
  return e.before === null ? "insert" : e.after === null ? "delete" : "update";
}
