import "server-only";

/**
 * Form di una voce d'orario (ScheduleEntryForm, include/class.schedule.php): validazione dei campi
 * visibili e conversione nei valori della riga schedule_entry. Senza accesso al DB.
 */

export const FREQUENCIES = ["never", "daily", "weekly", "monthly", "yearly"] as const;
const WEEKS = ["1", "2", "3", "4", "5", "-1"];
const DAYS = ["1", "2", "3", "4", "5", "6", "7"];

/** Variabili del form di una voce (ScheduleEntryForm), già nel formato dei campi HTML. */
export interface EntryInput {
  name?: string;
  /** data di inizio Y-m-d */
  starts_on?: string;
  allday?: boolean;
  /** HH:MM */
  starts_at?: string;
  ends_at?: string;
  repeats?: string;
  /** Y-m-d (facoltativa) */
  stops_on?: string;
  weekly_day?: string;
  monthly?: string;
  monthly_day?: string;
  yearly?: string;
  yearly_day?: string;
  yearly_month?: string;
}

export type EntryVars = Record<string, string | number | null>;

const pad = (n: number) => String(n).padStart(2, "0");

/** Data e ora "da parete" di un istante nel fuso indicato. */
function wall(ms: number, tz: string): { y: number; m: number; d: number; H: number; M: number; S: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  return { y: +parts.year, m: +parts.month, d: +parts.day, H: +parts.hour, M: +parts.minute, S: +parts.second };
}

/**
 * Data del datepicker (DatetimePickerWidget::getValue + Format::parseDateTime): la data è letta come
 * mezzanotte UTC (fuso predefinito del PHP) e convertita nel fuso dell'agente/di sistema; nei fusi a
 * ovest di UTC il giorno risultante è quello precedente (comportamento del PHP replicato).
 */
function parseDate(v: string | undefined, tz: string): { ms: number; ymd: string; dt: string; d: string; m: string } | null {
  const mt = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v ?? "");
  if (!mt) return null;
  const ms = Date.UTC(+mt[1], +mt[2] - 1, +mt[3]);
  if (Number.isNaN(ms)) return null;
  const w = wall(ms, tz);
  const ymd = `${w.y}-${pad(w.m)}-${pad(w.d)}`;
  return { ms, ymd, dt: `${ymd} ${pad(w.H)}:${pad(w.M)}:${pad(w.S)}`, d: pad(w.d), m: pad(w.m) };
}

function parseTime(v: string | undefined): [number, number] | null {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec((v ?? "").trim());
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return [+m[1], +m[2]];
}

/** ScheduleEntryForm::isValid() + process(): campi obbligatori visibili, poi i valori della voce. */
export function processEntryForm(input: EntryInput, holidays: boolean, tz = "UTC"): { vars: EntryVars } | { errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const allday = input.allday ?? holidays;
  if (!input.name?.trim()) errors.name = "required";
  if (!input.starts_on) errors.starts_on = "required";
  if (!allday) {
    if (!input.starts_at) errors.starts_at = "required";
    if (!input.ends_at) errors.ends_at = "required";
  }
  const repeats = input.repeats ?? "";
  if (!(FREQUENCIES as readonly string[]).includes(repeats)) errors.repeats = "required";
  if (repeats === "weekly" && ![...DAYS, "weekdays", "weekends"].includes(input.weekly_day ?? "")) errors.weekly_day = "required";
  if (repeats === "monthly") {
    const monthly = input.monthly ?? "day";
    if (!["day", ...WEEKS].includes(monthly)) errors.monthly = "required";
    else if (monthly !== "day" && !DAYS.includes(input.monthly_day ?? "")) errors.monthly_day = "required";
  }
  if (repeats === "yearly") {
    const yearly = input.yearly ?? "";
    if (!["date", ...WEEKS].includes(yearly)) errors.yearly = "required";
    else if (yearly !== "date") {
      if (!DAYS.includes(input.yearly_day ?? "")) errors.yearly_day = "required";
      if (!/^(?:[1-9]|1[0-2])$/.test(input.yearly_month ?? "")) errors.yearly_month = "required";
    }
  }
  if (Object.keys(errors).length) return { errors };

  const startsOn = parseDate(input.starts_on, tz);
  if (!startsOn) return { errors: { starts_on: "invalid" } };
  const vars: EntryVars = { name: input.name!, repeats };
  const ymd = startsOn.ymd;
  vars.starts_on = ymd;
  const stopsOn = input.stops_on ? parseDate(input.stops_on, tz) : null;
  if (stopsOn && stopsOn.ms <= startsOn.ms) errors.ends_on = "future";
  let s: [number, number];
  let e: [number, number];
  if (allday) {
    s = [0, 0];
    e = [23, 59];
  } else {
    const ps = parseTime(input.starts_at);
    const pe = parseTime(input.ends_at);
    if (!ps || !pe) return { errors: { ends_at: "span" } };
    s = ps;
    e = pe;
    // strtotime(starts) >= strtotime(ends) + 59
    if (s[0] * 3600 + s[1] * 60 >= e[0] * 3600 + e[1] * 60 + 59) errors.ends_at = "span";
  }
  if (Object.keys(errors).length) return { errors };
  vars.starts_at = `${pad(s[0])}:${pad(s[1])}:00`;
  vars.ends_on = ymd;
  // secondi 59 se i minuti non sono "00"
  vars.ends_at = `${pad(e[0])}:${pad(e[1])}:${e[1] === 0 ? "00" : "59"}`;
  if (stopsOn) vars.stops_on = stopsOn.dt;
  const dd = startsOn.d;
  const mm = startsOn.m;
  switch (repeats) {
    case "weekly":
      if (input.weekly_day === "weekdays" || input.weekly_day === "weekends") vars.repeats = input.weekly_day;
      else vars.day = input.weekly_day!;
      break;
    case "monthly":
      vars.day = input.monthly_day || null;
      if ((input.monthly ?? "day") === "day") vars.day = dd;
      else vars.week = input.monthly!;
      break;
    case "yearly":
      if (input.yearly === "date") {
        vars.week = null;
        vars.day = dd;
        vars.month = mm;
      } else {
        vars.week = input.yearly!;
        vars.day = input.yearly_day!;
        vars.month = input.yearly_month!;
      }
      break;
  }
  return { vars };
}

/** Descrizione di una voce (ScheduleEntry::getDesc): chiave del testo e parametri, senza traduzioni. */
export type EntryDesc =
  | { key: "never"; date: string }
  | { key: "daily" | "weekdays" | "weekends" }
  | { key: "weekly"; day: number }
  | { key: "monthlyDay"; day: number }
  | { key: "monthlyWeek"; week: number; day: number }
  | { key: "yearlyDate"; day: number; month: number }
  | { key: "yearlyWeek"; week: number; day: number; month: number };

interface EntryRow {
  repeats: string;
  day: number | null;
  week: number | null;
  month: number | null;
  starts_on: string | null;
  starts_at: string | null;
  ends_at: string | null;
}

export function describeEntry(e: EntryRow): EntryDesc {
  const day = Number(e.day ?? 0);
  const week = Number(e.week ?? 0);
  const month = Number(e.month ?? 0);
  switch (e.repeats) {
    case "weekly":
      return { key: "weekly", day };
    case "monthly":
      return week ? { key: "monthlyWeek", week, day } : { key: "monthlyDay", day };
    case "yearly":
      return week ? { key: "yearlyWeek", week, day, month } : { key: "yearlyDate", day, month };
    case "daily":
    case "weekdays":
    case "weekends":
      return { key: e.repeats };
    default:
      return { key: "never", date: String(e.starts_on ?? "").slice(0, 10) };
  }
}

/** ScheduleEntry::isFullDay(): dalle 00:00:00 alle 23:59:59. */
export function isFullDayEntry(e: Pick<EntryRow, "starts_at" | "ends_at">): boolean {
  return String(e.starts_at ?? "").startsWith("00:00:00") && String(e.ends_at ?? "").startsWith("23:59:59");
}

/**
 * Ordine mostrato nel form (schedule-entries.tmpl.php: `$entry->sort ?: ++$sort`): le voci con ordine 0
 * (nuove o clonate) prendono un progressivo, che diventa definitivo al salvataggio dell'orario.
 */
export function displaySortOrder(sorts: number[]): number[] {
  let n = 0;
  return sorts.map((s) => s || ++n);
}
