import "server-only";

import { checkSecretSalt, checkTablePrefix, checkTimezone } from "./checks";
import type { DoctorCheck } from "./types";

/**
 * Controlli critici del doctor rieseguiti a runtime: economici (poche query brevi, nessuna rete) e
 * tali che, se falliscono, una scrittura di TailTicket potrebbe danneggiare i dati di osTicket.
 * Li usa write-mode.ts per abbassare la modalità effettiva a sola lettura.
 *  - table_prefix: tabelle principali mancanti con il prefisso configurato (errore della query = critico);
 *  - secret_salt: salt discordante con i dati di osTicket (non verificabile = non critico);
 *  - timezone: offset del DB incoerente con quello dell'app o di osTicket (errore = critico).
 * La firma dello schema è già verificata da schema-compat.ts in write-mode.ts: qui non si ripete.
 * Privilegi, SMTP, storage e plugin servono solo al report (runDoctor).
 */
const RUNTIME_CHECKS: readonly (() => Promise<DoctorCheck>)[] = [checkTablePrefix, checkSecretSalt, checkTimezone];

const CACHE_MS = 60_000;

const g = globalThis as typeof globalThis & {
  __ttDoctorRuntime?: { at: number; value: string[] } | null;
  __ttDoctorInflight?: Promise<string[]> | null;
};

async function compute(): Promise<string[]> {
  // ogni controllo cattura i propri errori (checks.ts): qui non arrivano eccezioni. In sequenza: si può
  // arrivare qui dal gate di una scrittura che tiene già una connessione del pool, meglio occuparne una sola.
  const failed: string[] = [];
  for (const check of RUNTIME_CHECKS) {
    const c = await check();
    if (c.level === "block") failed.push(c.id);
  }
  return failed;
}

/** Codici dei controlli critici falliti (vuoto = nessun problema), con cache di 60 s. */
export async function criticalDoctorFailures(): Promise<string[]> {
  const c = g.__ttDoctorRuntime;
  if (c && Date.now() - c.at < CACHE_MS) return c.value;
  g.__ttDoctorInflight ??= compute()
    .then((value) => {
      g.__ttDoctorRuntime = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      g.__ttDoctorInflight = null;
    });
  return g.__ttDoctorInflight;
}
