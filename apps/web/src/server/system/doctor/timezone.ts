import { DateTime } from "luxon";

/**
 * Coerenza del fuso del database. I datetime di osTicket sono "ora da parete" nel fuso del server
 * MySQL (NOW()); TailTicket interpreta e scrive le date calcolate nel fuso di src/server/db/time.ts
 * (OST_DB_TIMEZONE o quello dichiarato da MySQL); il PHP usa `core.db_timezone`, determinato una volta
 * da DbTimezone::determine() (include/class.timezone.php). I tre offset correnti devono coincidere,
 * altrimenti scadenze e date scritte da TailTicket sarebbero spostate rispetto a quelle del PHP.
 */
interface OffsetInputs {
  /** TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), NOW()) del server MySQL */
  mysqlSeconds: number;
  /** fuso usato dall'app (null se non determinabile) */
  appZone: string | null;
  /** core.db_timezone ("" se assente) */
  ostZone: string;
  /** istante di riferimento (per i test) */
  at?: DateTime;
}

interface OffsetComparison {
  coherent: boolean;
  /** fusi non riconosciuti (nome non valido) */
  invalid: string[];
  mysqlMinutes: number;
  appMinutes: number | null;
  ostMinutes: number | null;
}

/** Offset in minuti di un fuso IANA all'istante dato, null se il nome non è valido. */
export function zoneOffsetMinutes(zone: string, at: DateTime = DateTime.utc()): number | null {
  const dt = at.setZone(zone);
  return dt.isValid ? dt.offset : null;
}

export function compareOffsets(i: OffsetInputs): OffsetComparison {
  const at = i.at ?? DateTime.utc();
  // arrotondato al minuto: i secondi tra le due letture non contano
  const mysqlMinutes = Math.round(i.mysqlSeconds / 60);
  const invalid: string[] = [];
  const appMinutes = i.appZone ? zoneOffsetMinutes(i.appZone, at) : null;
  if (i.appZone && appMinutes === null) invalid.push(i.appZone);
  const ostMinutes = i.ostZone ? zoneOffsetMinutes(i.ostZone, at) : null;
  if (i.ostZone && ostMinutes === null) invalid.push(i.ostZone);
  const coherent = appMinutes !== null && appMinutes === mysqlMinutes && (ostMinutes === null ? !i.ostZone : ostMinutes === mysqlMinutes);
  return { coherent, invalid, mysqlMinutes, appMinutes, ostMinutes };
}

/** "+02:00", "-05:30", "+00:00" */
export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}
