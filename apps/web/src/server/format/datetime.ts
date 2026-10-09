import "server-only";

import { DateTime } from "luxon";

import { coreConfig } from "../config/config";
import type { DbDateTime } from "../db/schema.gen";
import { fromDb } from "../db/time";
import type { Agent } from "../domain/staff/staff";

/** Fuso di visualizzazione: preferenza dell'agente, altrimenti core.default_timezone (OsticketConfig::getTimezone). */
export async function agentTimeZone(agent: Agent | null): Promise<string> {
  return agent?.row.timezone || (await coreConfig()).str("default_timezone") || "UTC";
}

export type DateStyle = "full" | "short" | "date" | "human";

/** Formatta un datetime del DB nel fuso e nella lingua dell'utente (Format::datetime / relativeTime). */
export function formatDbDate(value: DbDateTime | null | undefined, tz: string, locale: string, style: DateStyle = "full"): string {
  const dt = fromDb(value);
  if (!dt) return "";
  const local = dt.setZone(tz).setLocale(locale);
  switch (style) {
    case "date":
      return local.toLocaleString(DateTime.DATE_MED);
    case "short":
      return local.toLocaleString(DateTime.DATETIME_SHORT);
    case "human":
      return local.toRelative({ locale }) ?? local.toLocaleString(DateTime.DATETIME_SHORT);
    default:
      return local.toLocaleString(DateTime.DATETIME_MED);
  }
}

export function isoOf(value: DbDateTime | null | undefined): string | undefined {
  return fromDb(value)?.toISO() ?? undefined;
}
