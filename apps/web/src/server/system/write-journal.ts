import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { WriteContextInfo } from "./write-mode";

/**
 * Registro delle scritture (TAILTICKET_JOURNAL_DIR): una riga JSON per ogni operazione di scrittura
 * completata (transazione confermata o scrittura singola fuori transazione) nel file
 * `<dir>/writes-YYYY-MM-DD.jsonl` (data UTC). Esempio di riga:
 *
 *   {"ts":"2026-10-10T08:15:30.123Z","scope":"operational","actor":{"type":"agent","id":3},
 *    "op":"agent.login","tables":{"ost_config":["delete"],"ost_staff":["update"]}}
 *
 *  - ts: fine dell'operazione, ISO 8601 UTC;
 *  - scope: "operational" | "admin" | "none" (scrittura fuori da ogni scope);
 *  - actor: tipo ("agent" | "client" | "system") e id, se noti; assente se sconosciuto;
 *  - op: nome dell'operazione, oppure "action:<id>" della server action o la route; assente se ignoto;
 *  - tables: tabelle reali (con prefisso) → verbi SQL in ordine alfabetico ("?" se non riconosciuta).
 * Mai valori, testi dei messaggi o dati personali. Scrittura asincrona, in ordine, tollerante agli
 * errori: un registro non scrivibile non fa fallire l'operazione (un solo avviso su console).
 */
const JOURNAL_ENV = "TAILTICKET_JOURNAL_DIR";

export type JournalTables = Record<string, string[]>;

interface JournalEntry {
  ts: string;
  scope: string;
  actor?: { type: string; id?: number };
  op?: string;
  tables: JournalTables;
}

export function journalEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return !!env[JOURNAL_ENV]?.trim();
}

export function journalEntry(context: WriteContextInfo | undefined, tables: JournalTables, now = new Date()): JournalEntry {
  const entry: JournalEntry = {
    ts: now.toISOString(),
    scope: context?.scope ?? "none",
    tables,
  };
  if (context?.actor) entry.actor = context.actor.id !== undefined ? { type: context.actor.type, id: context.actor.id } : { type: context.actor.type };
  if (context?.op) entry.op = context.op;
  return entry;
}

export function journalFileName(now: Date): string {
  return `writes-${now.toISOString().slice(0, 10)}.jsonl`;
}

const g = globalThis as typeof globalThis & {
  __ttJournalQueue?: Promise<void>;
  __ttJournalWarned?: boolean;
};

/** Accoda la riga del registro (nessun effetto senza TAILTICKET_JOURNAL_DIR). */
export function journalWrite(context: WriteContextInfo | undefined, tables: JournalTables): void {
  const dir = process.env[JOURNAL_ENV]?.trim();
  if (!dir || !Object.keys(tables).length) return;
  const now = new Date();
  const line = JSON.stringify(journalEntry(context, tables, now)) + "\n";
  const file = join(dir, journalFileName(now));
  g.__ttJournalQueue = (g.__ttJournalQueue ?? Promise.resolve())
    .then(async () => {
      await mkdir(dir, { recursive: true });
      await appendFile(file, line, { encoding: "utf8", mode: 0o640 });
    })
    .catch((err: unknown) => {
      if (g.__ttJournalWarned) return;
      g.__ttJournalWarned = true;
      console.error(`[write-journal] registro delle scritture non scrivibile in ${dir}: ${(err as Error).message}`);
    });
}

/**
 * Operazione della richiesta corrente, quando il chiamante non la indica: id della server action
 * (header Next-Action). Solo con il registro attivo; fuori da una richiesta Next undefined.
 */
export async function requestOpForJournal(): Promise<string | undefined> {
  if (!journalEnabled()) return undefined;
  try {
    const { headers } = await import("next/headers");
    const action = (await headers()).get("next-action");
    if (action && /^[\w-]+$/.test(action)) return `action:${action}`;
  } catch {
    // fuori da una richiesta (script, test)
  }
  return undefined;
}

/** Solo per i test: attende le scritture accodate. */
export function journalFlushForTests(): Promise<void> {
  return g.__ttJournalQueue ?? Promise.resolve();
}
