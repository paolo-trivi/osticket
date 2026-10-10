/**
 * Modalità di scrittura lato interfaccia (specchio di src/server/system/write-mode.ts, che resta
 * server-only): cosa può scrivere l'utente e come spiegare una sola lettura automatica.
 * Il gate vero è sul server; qui si decide solo cosa mostrare.
 */
export type WriteMode = "readonly" | "operational" | "full";
export type WriteScope = "operational" | "admin";

const RANK: Record<WriteMode, number> = {
  readonly: 0,
  operational: 1,
  full: 2,
};

/** readonly: nulla; operational: ticket, task, persone, profilo e portale; full: anche l'amministrazione. */
export function modeAllows(mode: WriteMode, scope: WriteScope): boolean {
  return scope === "admin" ? mode === "full" : mode !== "readonly";
}

/** Motivi di una sola lettura automatica, come chiavi di writeMode.reasons. */
export type ReadOnlyReason = "schema" | "schemaUnreadable" | "tablePrefix" | "secretSalt" | "timezone" | "critical" | "doctorFailed" | "other";

/** Codici di effectiveWriteMode (write-mode.ts) e dei controlli critici del doctor (doctor/runtime.ts). */
const REASONS: Record<string, ReadOnlyReason> = {
  schema_unverified: "schema",
  schema_unreadable: "schemaUnreadable",
  doctor_failed: "doctorFailed",
  "doctor:table_prefix": "tablePrefix",
  "doctor:secret_salt": "secretSalt",
  "doctor:timezone": "timezone",
};

/**
 * Motivi da mostrare nel banner: solo se la modalità effettiva è più restrittiva di quella configurata
 * (sola lettura scattata da sola). Un controllo del doctor non previsto qui vale "critical", un codice
 * sconosciuto "other" (mai il codice grezzo); nessun duplicato, nell'ordine di arrivo.
 */
export function readOnlyReasons(configured: WriteMode, effective: WriteMode, reasons: readonly string[]): ReadOnlyReason[] {
  if (RANK[effective] >= RANK[configured]) return [];
  const out: ReadOnlyReason[] = [];
  for (const code of reasons.length ? reasons : [""]) {
    const r = Object.hasOwn(REASONS, code) ? REASONS[code] : code.startsWith("doctor:") ? "critical" : code.startsWith("schema") ? "schema" : "other";
    if (!out.includes(r)) out.push(r);
  }
  return out;
}
