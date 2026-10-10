import "server-only";

import { installConfig } from "../../env";
import { effectiveWriteMode, writeModeConfigured } from "../write-mode";
import { checkAuthBackends, checkCron, checkGrants, checkOutgoingMail, checkPlugins, checkSchema, checkSecretSalt, checkStorage, checkTablePrefix, checkTimezone } from "./checks";
import { errorText, summarize, type DoctorCheck, type DoctorReport } from "./types";

/**
 * Doctor: tutti i controlli del collegamento a osTicket, per /api/doctor (CLI di installazione) e per
 * la pagina /admin/system. I controlli critici a runtime sono in runtime.ts.
 */
const REASONS: Record<string, string> = {
  schema_unverified: "schema del DB non verificato",
  schema_unreadable: "firma dello schema non leggibile",
  doctor_failed: "doctor non eseguibile",
  "doctor:table_prefix": "tabelle mancanti con il prefisso configurato",
  "doctor:secret_salt": "SECRET_SALT incoerente",
  "doctor:timezone": "fuso orario incoerente",
};

async function checkWriteMode(): Promise<DoctorCheck> {
  const id = "write_mode";
  const title = "Modalità di scrittura";
  try {
    const mode = await effectiveWriteMode();
    const reasons = mode.reasons.map((r) => REASONS[r] ?? r);
    const why = reasons.length ? ` (sola lettura per: ${reasons.join(", ")})` : "";
    if (!writeModeConfigured()) {
      // senza TAILTICKET_MODE vale full, ma il gate abbassa comunque a sola lettura (schema, controlli critici)
      return {
        id,
        title,
        level: "info",
        detail: `TAILTICKET_MODE non impostata: vale full. Modalità effettiva: ${mode.effective}${why}.`,
        hint: "Per collegarsi a un osTicket in produzione imposta TAILTICKET_MODE (readonly, operational o full).",
      };
    }
    return {
      id,
      title,
      level: "info",
      detail: `Modalità configurata: ${mode.configured} (TAILTICKET_MODE). Modalità effettiva: ${mode.effective}${why}.`,
    };
  } catch (ex) {
    return {
      id,
      title,
      level: "info",
      detail: `Non verificabile: ${errorText(ex)}`,
    };
  }
}

/** Dati di connessione presi da variabili d'ambiente invece che da ost-config.php (utente dedicato, host). */
function checkConnectionSource(): DoctorCheck {
  const id = "connection_source";
  const title = "Fonte dei dati di connessione";
  const overrides = installConfig().connectionOverrides;
  if (!process.env.OST_CONFIG_PATH) {
    return {
      id,
      title,
      level: "info",
      detail: "Connessione e identità da variabili d'ambiente (nessun ost-config.php montato).",
    };
  }
  if (!overrides.length)
    return {
      id,
      title,
      level: "ok",
      detail: "Connessione e identità lette da ost-config.php.",
    };
  return {
    id,
    title,
    level: "warn",
    detail: `Identità (DB, prefisso, SECRET_SALT) da ost-config.php; connessione diversa dal file per: ${overrides.join(", ")}.`,
    hint: "È il caso previsto per un utente MySQL dedicato o per raggiungere il DB dal container: verifica che punti allo stesso database del PHP.",
  };
}

export async function runDoctor(): Promise<DoctorReport> {
  const checks = await Promise.all([
    checkSchema(),
    checkTablePrefix(),
    checkSecretSalt(),
    checkTimezone(),
    checkGrants(),
    checkOutgoingMail(),
    checkStorage(),
    checkPlugins(),
    checkAuthBackends(),
    checkCron(),
    checkWriteMode(),
  ]);
  checks.splice(2, 0, checkConnectionSource());
  return { checks, summary: summarize(checks) };
}
