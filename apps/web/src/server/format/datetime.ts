import "server-only";

import { DateTime } from "luxon";

import { coreConfig, type ConfigNamespace } from "../config/config";
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

/** Format::date / datetime / time / daydatetime (include/class.format.php). */
type PhpDateKind = "date" | "datetime" | "time" | "daydatetime";

const CUSTOM_FORMAT_KEY: Record<PhpDateKind, string> = { date: "date_format", datetime: "datetime_format", time: "time_format", daydatetime: "daydatetime_format" };
/** pattern usati se la chiave manca dalla config (il PHP le richiede tutte) */
const CUSTOM_FORMAT_DEFAULT: Record<PhpDateKind, string> = { date: "MM/dd/y", datetime: "MM/dd/y h:mm a", time: "h:mm a", daydatetime: "EEE, MMM d y h:mm a" };

/**
 * Format::date / datetime / time / daydatetime di un istante nel fuso indicato: con `date_formats = custom`
 * il pattern della config core, altrimenti i formati ICU della lingua di sistema (data SHORT, ora SHORT,
 * datetime = data + " " + ora, daydatetime = data FULL + ora SHORT). Unica implementazione per i campi dei
 * form (filtri, indice) e per le variabili delle email (FormattedDate).
 */
export function phpFormatDate(dt: DateTime, cfg: ConfigNamespace, timezone: string, kind: PhpDateKind): string {
  const z = dt.setZone(timezone || "UTC");
  if (cfg.str("date_formats") === "custom") return z.setLocale("en-US").toFormat(cfg.str(CUSTOM_FORMAT_KEY[kind]) || CUSTOM_FORMAT_DEFAULT[kind]);
  const locale = (cfg.str("system_language") || "en_US").replace("_", "-");
  // ICU >= 72 (PHP intl) separa l'ora da AM/PM con U+202F; V8 può restituire uno spazio normale
  const icu = (opts: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(locale, { ...opts, timeZone: z.zoneName ?? "UTC" })
      .formatToParts(z.toJSDate())
      .map((p, i, all) => (p.type === "literal" && p.value === " " && all[i + 1]?.type === "dayPeriod" ? " " : p.value))
      .join("");
  switch (kind) {
    case "date":
      return icu({ dateStyle: "short" });
    case "time":
      return icu({ timeStyle: "short" });
    case "daydatetime":
      return icu({ dateStyle: "full", timeStyle: "short" });
    default:
      return `${icu({ dateStyle: "short" })} ${icu({ timeStyle: "short" })}`;
  }
}
