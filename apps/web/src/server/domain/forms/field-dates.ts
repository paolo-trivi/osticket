import "server-only";

import { DateTime } from "luxon";

/** Date dei campi come il PHP: lettura (Format::parseDateTime) e abbreviazione del fuso (DateTime::format('T')). */

/** Abbreviazioni di fuso riconosciute da strtotime/new DateTime (offset in minuti) */
const TZ_ABBR: Record<string, number> = {
  UTC: 0, GMT: 0, Z: 0, WET: 0, WEST: 60, BST: 60, CET: 60, CEST: 120, EET: 120, EEST: 180, MSK: 180,
  EST: -300, EDT: -240, CST: -360, CDT: -300, MST: -420, MDT: -360, PST: -480, PDT: -420, IST: 330, JST: 540,
};

/**
 * Format::parseDateTime / new DateTime($value): un valore senza fuso è letto nel fuso predefinito del
 * PHP (bootstrap.php: UTC); offset espliciti e abbreviazioni (CEST, EST…) sono rispettati.
 */
export function phpParseDateTime(value: string): DateTime | null {
  const v = String(value ?? "").trim();
  if (!v) return null;
  if (/^\d+$/.test(v)) return DateTime.fromSeconds(Number(v), { zone: "UTC" });
  let base = v;
  let zone = "UTC";
  const abbr = /^(.*\d)\s+([A-Za-z]{1,5}|[+-]\d{2}(?::?\d{2})?)$/.exec(v);
  if (abbr) {
    const z = abbr[2].toUpperCase();
    if (z in TZ_ABBR) {
      const m = TZ_ABBR[z];
      zone = m === 0 ? "UTC" : `UTC${m > 0 ? "+" : "-"}${Math.floor(Math.abs(m) / 60)}${Math.abs(m) % 60 ? `:${String(Math.abs(m) % 60).padStart(2, "0")}` : ""}`;
      base = abbr[1];
    } else if (/^[+-]\d/.test(z)) {
      const mm = /^([+-])(\d{2}):?(\d{2})?$/.exec(z)!;
      zone = `UTC${mm[1]}${Number(mm[2])}${mm[3] && mm[3] !== "00" ? `:${mm[3]}` : ""}`;
      base = abbr[1];
    }
  }
  const opts = { zone, setZone: true };
  for (const dt of [
    DateTime.fromISO(base, opts),
    DateTime.fromSQL(base, opts),
    DateTime.fromFormat(base, "M/d/yyyy", opts),
    DateTime.fromFormat(base, "M/d/yyyy H:mm", opts),
    DateTime.fromFormat(base, "M/d/yyyy h:mm a", opts),
    DateTime.fromFormat(base, "M/d/yy", opts),
  ]) {
    if (dt.isValid) return dt;
  }
  return null;
}

/** DateTime::format('T') del PHP: abbreviazione del fuso (CEST, EST…) o offset "+03" / "+0530". */
export function phpTzAbbr(dt: DateTime): string {
  if (dt.zoneName === "UTC" || dt.zoneName === "Etc/UTC") return "UTC";
  const name = (locale: string) =>
    new Intl.DateTimeFormat(locale, { timeZone: dt.zoneName ?? "UTC", timeZoneName: "short" }).formatToParts(dt.toJSDate()).find((p) => p.type === "timeZoneName")?.value ?? "";
  for (const locale of ["en-GB", "en-US"]) {
    const n = name(locale);
    if (n && !/^(GMT|UTC)[+-−]/.test(n)) return n;
  }
  const off = dt.offset;
  const h = String(Math.floor(Math.abs(off) / 60)).padStart(2, "0");
  const m = Math.abs(off) % 60;
  return `${off < 0 ? "-" : "+"}${h}${m ? String(m).padStart(2, "0") : ""}`;
}
