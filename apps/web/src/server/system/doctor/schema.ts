import { VERIFIED_SCHEMAS, type SchemaStatus } from "../schema-compat";
import type { DoctorCheck } from "./types";

/**
 * Esito del controllo "schema" del doctor dalla firma (puro, senza DB): versione di osTicket rilevata e
 * cosa fare.
 *  - firma verificata → supporto completo (lettura e scrittura);
 *  - release nota ma non verificata (versioni precedenti) → sola lettura, aggiornare osTicket;
 *  - firma sconosciuta (release più recente, upgrade non completato, schema modificato) → sola lettura
 *    finché la versione non è verificata.
 */
export function schemaVerdict(st: SchemaStatus): Omit<DoctorCheck, "id" | "title"> {
  const sig = st.signature || "assente";
  const supported = VERIFIED_SCHEMAS.map((v) => v.osticket).join(", ");
  const forced = st.override ? " È impostato TAILTICKET_ALLOW_UNVERIFIED_SCHEMA=1, ma il doctor la considera comunque non sicura." : "";
  if (st.verified)
    return {
      level: "ok",
      detail:
        `osTicket ${st.verified.osticket} rilevato (firma ${sig}): supporto completo, lettura e scrittura. ` +
        "La firma è la stessa per tutte le patch della serie: conviene la patch su cui TailTicket è verificato.",
    };
  if (st.known)
    return {
      level: "block",
      detail:
        `osTicket ${st.known.series} rilevato (firma ${sig}): versione non verificata da TailTicket, scritture disabilitate (sola lettura). ` +
        `Lo schema e il comportamento del PHP differiscono da quelli verificati (${supported}): anche la consultazione può essere incompleta.${forced}`,
      hint: `Aggiorna osTicket a una versione verificata (${supported}) con il suo upgrader (scp/upgrade.php), dopo un backup del database: TailTicket torna in scrittura da solo quando la firma risulta verificata.`,
    };
  return {
    level: "block",
    detail:
      (st.signature
        ? `Firma dello schema ${sig} sconosciuta: non è di una release osTicket nota a TailTicket. Può essere una versione più recente (es. 1.19 o 2.x), ` +
          "un aggiornamento di osTicket non completato o uno schema modificato."
        : "Firma dello schema assente (config core.schema_signature): il database potrebbe non essere di osTicket o l'installazione non è completa.") +
      ` Scritture disabilitate finché la versione non è verificata (sola lettura).${forced}`,
    hint: `Usa una versione di TailTicket che supporta questa versione di osTicket (oggi: ${supported}). Se l'aggiornamento di osTicket è a metà, completalo dal pannello PHP (scp/upgrade.php).`,
  };
}
