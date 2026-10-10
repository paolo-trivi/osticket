import type { ChangeEntry } from "./types";
import { rowKey, sameCell, type RowImage } from "./values";

/**
 * Piano dell'annullamento di un changeset (funzioni pure, restore.ts le esegue in una transazione):
 *  - conflitti: per ogni riga, lo stato atteso è l'after-image dell'ultima voce che la tocca; se la riga
 *    attuale è diversa (qualcuno l'ha cambiata dopo, es. dal pannello classico) è un conflitto;
 *  - operazioni: voci in ordine inverso, ognuna riporta la riga al suo before-image (riga inserita →
 *    DELETE per chiave; riga eliminata → INSERT; riga modificata → UPDATE delle colonne cambiate).
 */
export interface Conflict {
  table: string;
  pk: RowImage;
  /** changed: riga diversa; missing: riga sparita; exists: riga ricomparsa (era stata eliminata) */
  kind: "changed" | "missing" | "exists";
}

export type RestoreOp = { kind: "delete"; table: string; pk: RowImage } | { kind: "insert"; table: string; row: RowImage } | { kind: "update"; table: string; pk: RowImage; set: RowImage };

/** Righe attuali per chiave (entryKey): riga intera, o null se non c'è. */
export type CurrentRows = Map<string, RowImage | null>;

export function entryKey(table: string, pk: RowImage): string {
  const cols = Object.keys(pk).sort();
  return `${table}\u0000${cols.join(",")}\u0000${rowKey(pk, cols)}`;
}

/** Righe toccate (una volta sola), per la lettura dello stato attuale. */
export function touchedRows(entries: readonly ChangeEntry[]): { table: string; pk: RowImage }[] {
  const seen = new Map<string, { table: string; pk: RowImage }>();
  for (const e of entries) seen.set(entryKey(e.table, e.pk), { table: e.table, pk: e.pk });
  return [...seen.values()];
}

export function findConflicts(entries: readonly ChangeEntry[], current: CurrentRows): Conflict[] {
  const expected = new Map<string, ChangeEntry>();
  for (const e of entries) expected.set(entryKey(e.table, e.pk), e);
  const out: Conflict[] = [];
  for (const [key, e] of expected) {
    const now = current.get(key) ?? null;
    if (e.after === null) {
      if (now) out.push({ table: e.table, pk: e.pk, kind: "exists" });
    } else if (!now) out.push({ table: e.table, pk: e.pk, kind: "missing" });
    else if (Object.keys(e.after).some((c) => !sameCell(now[c], e.after![c]))) out.push({ table: e.table, pk: e.pk, kind: "changed" });
  }
  return out;
}

/**
 * Operazioni per riportare le righe allo stato precedente, partendo dallo stato attuale (con `force` le
 * righe in conflitto vengono sovrascritte: una riga eliminata e già ricomparsa si aggiorna invece di
 * inserirla). `skipped`: modifiche di righe che nel frattempo non esistono più (solo con force).
 */
export function restoreOps(entries: readonly ChangeEntry[], current: CurrentRows): { ops: RestoreOp[]; skipped: number } {
  const state = new Map(current);
  const ops: RestoreOp[] = [];
  let skipped = 0;
  for (const e of [...entries].reverse()) {
    const key = entryKey(e.table, e.pk);
    const now = state.get(key) ?? null;
    if (e.before === null) {
      if (now) ops.push({ kind: "delete", table: e.table, pk: e.pk });
      state.set(key, null);
    } else if (e.after === null) {
      if (now) ops.push({ kind: "update", table: e.table, pk: e.pk, set: withoutPk(e.before, e.pk) });
      else ops.push({ kind: "insert", table: e.table, row: e.before });
      state.set(key, { ...e.before });
    } else if (now) {
      ops.push({ kind: "update", table: e.table, pk: e.pk, set: e.before });
      state.set(key, { ...now, ...e.before });
    } else skipped++;
  }
  return { ops, skipped };
}

function withoutPk(row: RowImage, pk: RowImage): RowImage {
  return Object.fromEntries(Object.entries(row).filter(([c]) => !(c in pk)));
}

/** Righe in conflitto per l'interfaccia e il CLI: "tabella id=…" (solo le colonne della chiave). */
export function conflictLabel(c: Pick<Conflict, "table" | "pk">, prefix: string): string {
  const table = prefix && c.table.startsWith(prefix) ? c.table.slice(prefix.length) : c.table;
  return `${table} ${Object.entries(c.pk)
    .map(([k, v]) => `${k}=${typeof v === "object" && v ? "…" : String(v)}`)
    .join(",")}`;
}
