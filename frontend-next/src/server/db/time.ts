import "server-only";

import { DateTime } from "luxon";
import { sql } from "kysely";

import type { DbOrTx } from ".";
import type { DbDateTime } from "./schema.gen";

/**
 * Gestione del tempo compatibile con osTicket (doc 01 §12):
 * - i datetime nel DB sono "ora da parete" nel fuso del server MySQL (TIME_ZONE='SYSTEM');
 * - created/updated si scrivono con NOW() lato SQL;
 * - le date calcolate (es. est_duedate) si scrivono formattate 'Y-m-d H:i:s' nel fuso del DB,
 *   come Ticket::getSLADueDate().
 * Il PHP ricava il fuso con DbTimezone::determine(); qui si usa OST_DB_TIMEZONE (consigliato,
 * es. "Europe/Rome") oppure il fuso dichiarato dal server MySQL.
 */
const DB_FORMAT = "yyyy-MM-dd HH:mm:ss";
let dbZone: string | undefined;

export async function detectDbTimezone(executor: DbOrTx): Promise<string> {
  if (dbZone) return dbZone;
  if (process.env.OST_DB_TIMEZONE) {
    dbZone = process.env.OST_DB_TIMEZONE;
    return dbZone;
  }
  const { rows } = await sql<{ tz: string; sys: string; offset_min: number }>`
    SELECT @@session.time_zone AS tz, @@system_time_zone AS sys,
           TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), NOW()) AS offset_min`.execute(executor);
  const { tz, sys, offset_min } = rows[0];
  const candidate = tz !== "SYSTEM" ? tz : sys;
  if (candidate && DateTime.local().setZone(candidate).isValid) {
    dbZone = candidate;
  } else if (Number(offset_min) === 0) {
    dbZone = "UTC";
  } else {
    throw new Error(
      `Impossibile determinare il fuso del DB (${candidate}, offset ${offset_min} min): impostare OST_DB_TIMEZONE`,
    );
  }
  return dbZone;
}

/** Fuso del DB già determinato (chiamare prima detectDbTimezone). */
export function dbTimezone(): string {
  if (!dbZone) throw new Error("Fuso DB non ancora determinato: chiamare detectDbTimezone()");
  return dbZone;
}

/** Datetime vuoti o "zero" del MySQL (0000-00-00 ...) valgono null, come in PHP. */
export function isZeroDate(value: DbDateTime | null | undefined): boolean {
  return !value || value.startsWith("0000-00-00");
}

export function fromDb(value: DbDateTime | null | undefined): DateTime | null {
  if (isZeroDate(value)) return null;
  const dt = DateTime.fromFormat(String(value).slice(0, 19), DB_FORMAT, { zone: dbTimezone() });
  return dt.isValid ? dt : null;
}

export function toDb(dt: DateTime): DbDateTime {
  return dt.setZone(dbTimezone()).toFormat(DB_FORMAT);
}

export function nowInDb(): DateTime {
  return DateTime.now().setZone(dbTimezone());
}
