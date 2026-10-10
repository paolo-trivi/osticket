/**
 * Tipi del "doctor": la diagnostica che verifica, prima di consentire le scritture, che TailTicket
 * sia collegato in modo corretto e sicuro a un osTicket esistente (modalità attach).
 *
 * Livelli:
 * - ok: verificato, nessun problema;
 * - warn: da conoscere, non impedisce le scritture (anche "non verificabile" quando manca la fonte);
 * - block: le scritture non sono sicure finché il problema non è risolto;
 * - info: solo informazione.
 */
export type DoctorLevel = "ok" | "warn" | "block" | "info";

export interface DoctorCheck {
  /** codice stabile del controllo (es. "secret_salt") */
  id: string;
  level: DoctorLevel;
  /** titolo breve, in italiano */
  title: string;
  /** esito con il valore rilevato quando non è un segreto */
  detail: string;
  /** cosa fare per risolvere */
  hint?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  summary: { ok: number; warn: number; block: number };
}

export function summarize(checks: readonly DoctorCheck[]): DoctorReport["summary"] {
  return {
    ok: checks.filter((c) => c.level === "ok").length,
    warn: checks.filter((c) => c.level === "warn").length,
    block: checks.filter((c) => c.level === "block").length,
  };
}

/** Le scritture sono consentite dal doctor solo senza controlli bloccanti. */
export function isWritable(report: Pick<DoctorReport, "summary">): boolean {
  return report.summary.block === 0;
}

/** Messaggio d'errore di un controllo non verificabile, accorciato (mai segreti: solo il messaggio). */
export function errorText(ex: unknown): string {
  const msg = ex instanceof Error ? ex.message : String(ex);
  const line = msg.replace(/\s+/g, " ").trim();
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}
