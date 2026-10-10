import "server-only";

import type { ChangeRef } from "@/lib/changes";

import { installConfig } from "../../env";
import { ChangeRecorder, runWithRecorder } from "./recorder";
import { changesEnabled, newChangeId, saveChangeset } from "./store";
import type { Changeset, ChangeSummary, StaffRef } from "./types";

/**
 * Una modifica dell'area admin = un changeset (righe prima/dopo, ordine di conferma), registrato dal gate
 * delle scritture mentre `fn` è in esecuzione (anche su più transazioni) e salvato alla fine
 * (store.ts). Le transazioni annullate (rollback) non lasciano righe. Senza righe cambiate nessun changeset.
 * Senza TAILTICKET_JOURNAL_DIR la registrazione è spenta: `change` è null.
 */
interface ChangeMeta {
  staff: StaffRef | null;
  op?: string;
  path?: string;
  undoes?: string;
}

export async function withChangeset<T>(meta: ChangeMeta, fn: () => Promise<T>): Promise<{ result: T; change: ChangeRef | null }> {
  if (!changesEnabled()) return { result: await fn(), change: null };
  const prefix = installConfig().tablePrefix;
  const signature = await schemaSignature();
  // i log di sistema (syslog) si aggiungono e basta: un annullamento non li cancella
  const rec = new ChangeRecorder((table) => table === `${prefix}syslog`);
  let result: T;
  try {
    result = await runWithRecorder(rec, fn);
  } catch (err) {
    // anche se fn fallisce: le scritture già confermate (fuori dalla transazione fallita) restano registrate
    await store(rec, meta, prefix, signature);
    throw err;
  }
  return { result, change: await store(rec, meta, prefix, signature) };
}

async function schemaSignature(): Promise<string> {
  try {
    const { loadConfigNamespace } = await import("../../config/config");
    return (await loadConfigNamespace("core")).str("schema_signature");
  } catch {
    return "";
  }
}

export function changeRef(s: Pick<ChangeSummary, "id" | "undoable" | "reason" | "rows" | "undone">): ChangeRef {
  return { id: s.id, undoable: s.undoable && !s.undone, rows: s.rows, ...(s.reason && { reason: s.reason }) };
}

async function store(rec: ChangeRecorder, meta: ChangeMeta, prefix: string, signature: string): Promise<ChangeRef | null> {
  // nessuna riga cambiata (o solo righe di log): niente da annullare, nessun changeset
  if (!rec.failure && !rec.entries.length) return null;
  const touched: Record<string, string[]> = {};
  for (const [t, verbs] of rec.touched) touched[t] = [...verbs].sort();
  const cs: Changeset = {
    v: 1,
    id: newChangeId(),
    ts: new Date().toISOString(),
    staff: meta.staff,
    op: meta.op ?? null,
    path: meta.path ?? null,
    schema_signature: signature,
    prefix,
    undoable: !rec.failure && rec.entries.length > 0,
    ...(rec.failure && { reason: rec.failure.reason, detail: rec.failure.detail }),
    ...(meta.undoes && { undoes: meta.undoes }),
    touched,
    entries: rec.failure ? [] : rec.entries,
  };
  try {
    return changeRef(await saveChangeset(cs));
  } catch (err) {
    console.error("[changes] modifica non salvata: non sarà annullabile", err);
    return { id: cs.id, undoable: false, reason: "store_failed", rows: 0 };
  }
}

// ── Esito dei salvataggi admin → interfaccia ─────────────────────────────────────────────────────────

const g = globalThis as typeof globalThis & { __ttResultChanges?: WeakMap<object, ChangeRef> };
const resultChanges = (g.__ttResultChanges ??= new WeakMap<object, ChangeRef>());

/** Associa all'esito di adminWrite la modifica registrata (letta da adminFormResult, sysFormResult, massRedirect). */
export function withChange<T>(result: T, change: ChangeRef | null | undefined): T {
  if (change && result && typeof result === "object") resultChanges.set(result, change);
  return result;
}

export function changeOf(result: unknown): ChangeRef | undefined {
  return result && typeof result === "object" ? resultChanges.get(result) : undefined;
}

/** Pagina da cui parte la modifica (percorso del Referer), per l'elenco delle modifiche; fuori da una richiesta undefined. */
export async function requestPathForChanges(): Promise<string | undefined> {
  try {
    const { headers } = await import("next/headers");
    const ref = (await headers()).get("referer");
    return ref ? new URL(ref).pathname.slice(0, 200) : undefined;
  } catch {
    return undefined;
  }
}
