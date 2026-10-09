import "server-only";

import { sql } from "kysely";
import { DateTime } from "luxon";

import { loadConfigNamespace } from "../../config/config";
import { db, type DbOrTx } from "../../db";
import { PhpDateTime, strtotimeDateUtc, strtotimeUtc, timeOfDaySeconds } from "./php-datetime";

/**
 * Orari lavorativi di osTicket: Schedule / BusinessHoursSchedule / HolidaysSchedule / ScheduleEntry
 * (include/class.schedule.php) e BusinessHours::addWorkingHours (include/class.businesshours.php).
 *
 * Il codice è una traduzione riga per riga del PHP, comprese le sue stranezze (vedi i commenti
 * "STRANEZZA PHP"): serve che le scadenze calcolate qui coincidano al secondo con quelle già
 * salvate dal PHP (ticket.est_duedate). Le date sono `PhpDateTime`, che replica DateTime::modify().
 */

/** Schedule::FLAG_BIZHRS: orario lavorativo; senza il flag è un calendario di festività. */
const ScheduleFlag = { BIZHRS: 0x0001 } as const;

/** Riga di ost_schedule_entry (solo le colonne usate dal calcolo). */
export interface ScheduleEntryData {
  id: number;
  scheduleId: number;
  name: string;
  repeats: string;
  startsOn: string | null;
  startsAt: string | null;
  endsOn: string | null;
  endsAt: string | null;
  stopsOn: string | null;
  day: number | null;
  week: number | null;
  month: number | null;
}

/** Uno schedule caricato con le sue voci (ordine del DB) e, se lavorativo, i calendari festività. */
export interface ScheduleData {
  id: number;
  name: string;
  flags: number;
  /** Fuso effettivo: Schedule::getTimezone() = timezone dello schedule ?: $cfg->getTimezone() */
  timezone: string;
  entries: ScheduleEntryData[];
  /** BusinessHoursSchedule::getHolidaysSchedules() (vuoto per i calendari festività) */
  holidays: ScheduleData[];
}

const DAYS: Record<number, string> = {
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
  7: "Sunday",
};
const WEEKS: Record<number, string> = { 1: "First", 2: "Second", 3: "Third", 4: "Fourth", 5: "Fifth", [-1]: "Last" };
const MONTHS: Record<number, string> = {
  1: "January",
  2: "February",
  3: "March",
  4: "April",
  5: "May",
  6: "June",
  7: "July",
  8: "August",
  9: "September",
  10: "October",
  11: "November",
  12: "December",
};
// $array[null] in PHP → indice "" → valore mancante → stringa vuota in sprintf
const lookup = (map: Record<number, string>, key: number | null) => (key === null ? "" : (map[key] ?? ""));

/** Data/ora 'Y-m-d H:i:s' delle colonne DATE + TIME, come `sprintf('%s %s', starts_on, starts_at)`. */
function entryDatetime(date: string | null, time: string | null, zone: string): PhpDateTime {
  // new Datetime(" 08:00:00") (starts_on NULL) in PHP significa "oggi": stesso comportamento
  const d = date ? date.slice(0, 10) : DateTime.now().setZone(zone).toFormat("yyyy-MM-dd");
  return PhpDateTime.create(`${d} ${time ?? ""}`.trim(), zone);
}

/** ScheduleEntry (con lo stato interno _current/_starts/_ends/_stops del PHP). */
class ScheduleEntry {
  private starts?: PhpDateTime;
  private ends?: PhpDateTime;
  private stops?: PhpDateTime | null;
  private current: PhpDateTime | null = null;

  constructor(
    readonly data: ScheduleEntryData,
    readonly schedule: ScheduleData,
  ) {}

  get timezone(): string {
    return this.schedule.timezone;
  }

  getStartsDatetime(): PhpDateTime {
    this.starts ??= entryDatetime(this.data.startsOn, this.data.startsAt, this.timezone);
    return this.starts;
  }

  getEndsDatetime(): PhpDateTime {
    this.ends ??= entryDatetime(this.data.endsOn, this.data.endsAt, this.timezone);
    return this.ends;
  }

  getStartsTime(): string {
    return this.getStartsDatetime().format("H:i:s");
  }

  getEndsTime(): string {
    return this.getEndsDatetime().format("H:i:s");
  }

  getStopsDatetime(): PhpDateTime | null {
    if (this.stops === undefined) {
      // STRANEZZA PHP: '0000-00-00 00:00:00' è "vero" e diventa -0001-11-30: la voce non scatta mai
      if (this.data.stopsOn) this.stops = PhpDateTime.create(this.data.stopsOn, this.timezone);
      else if (this.isOneTime()) this.stops = this.getEndsDatetime();
      else this.stops = null;
    }
    return this.stops;
  }

  isOneTime(): boolean {
    return this.data.repeats.toLowerCase() === "never";
  }

  /**
   * Secondi lavorativi dall'ora di `date` alla fine della voce. STRANEZZA PHP: il calcolo usa la
   * data di riferimento della voce (starts_on), non il giorno effettivo, quindi l'ora legale del
   * giorno reale non conta.
   */
  diffTime(date: PhpDateTime): number {
    const start = this.getStartsDatetime().clone();
    const [h, m, s] = date.format("H:i:s").split(":").map(Number);
    start.setTime(h, m, s);
    return this.getEndsDatetime().getTimestamp() - start.getTimestamp();
  }

  /** Durata della voce. STRANEZZA PHP: 00:00:00-23:59:59 vale 86399 s (un secondo in meno al giorno). */
  diff(): number {
    return this.getEndsDatetime().getTimestamp() - this.getStartsDatetime().getTimestamp();
  }

  getHours(): number {
    return (this.diff() + 1) / 3600;
  }

  isFullDay(): boolean {
    return this.getHours() >= 24;
  }

  /** strtotime(H:i:s) con il fuso PHP predefinito (UTC): confronto tra orari del giorno. */
  isBeforeHours(dt: PhpDateTime): boolean {
    return timeOfDaySeconds(dt.format("H:i:s")) < timeOfDaySeconds(this.getStartsTime());
  }

  isAfterHours(dt: PhpDateTime): boolean {
    return timeOfDaySeconds(dt.format("H:i:s")) > timeOfDaySeconds(this.getEndsTime());
  }

  /** ScheduleEntry::getIntervalSpec: stringa per DateTime::modify() che porta alla prossima occorrenza. */
  getIntervalSpec(dt: PhpDateTime): string | undefined {
    const { repeats, day, week, month } = this.data;
    switch (repeats) {
      case "never":
        return this.getStartsDatetime().format("Y-m-d");
      case "daily":
        return `today ${dt.format("Y-m-d")}`;
      case "weekdays":
        return Number(dt.format("N")) > 5 ? "weekday" : `today ${dt.format("Y-m-d")}`;
      case "weekends":
        return Number(dt.format("N")) > 5 ? `today ${dt.format("Y-m-d")}` : `Next Saturday ${dt.format("Y-m-d")}`;
      case "weekly":
        return `${lookup(DAYS, day)} ${dt.format("Y-m-d")}`;
      case "monthly":
        if (!week && (day ?? 0) > 0) return `${dt.format("Y-m")}-${day}`;
        return `${lookup(WEEKS, week)} ${lookup(DAYS, day)} of ${dt.format("F")} ${Number(dt.format("Y"))}`;
      case "yearly":
        if ((week ?? 0) > 0)
          // STRANEZZA PHP: "October 2026 First Monday" salta il giorno 1 se è proprio quel giorno
          return `${lookup(MONTHS, month)} ${dt.format("Y")} ${lookup(WEEKS, week)} ${lookup(DAYS, day)}`;
        if (week === -1) return `last ${lookup(DAYS, day)} of ${lookup(MONTHS, month)} ${dt.format("Y")}`;
        return `${lookup(MONTHS, month)} ${Math.trunc(day ?? 0)} ${Number(dt.format("Y"))}`;
    }
    return undefined;
  }

  private applySpec(dt: PhpDateTime): void {
    const spec = this.getIntervalSpec(dt);
    // modify(null/'') in PHP fallisce lasciando la data invariata
    if (spec) dt.modify(spec);
  }

  /** ScheduleEntry::getCurrent($from) */
  getCurrent(from?: PhpDateTime): PhpDateTime | null {
    if (!this.current || from) {
      let f = from ? from.clone() : PhpDateTime.fromTimestamp(Math.floor(Date.now() / 1000), this.timezone);
      const start = this.getStartsDatetime();
      if (start.getTimestamp() > f.getTimestamp()) f = start.clone();
      const stop = this.getStopsDatetime();
      if (stop && stop.getTimestamp() < f.getTimestamp()) return null;
      this.applySpec(f);
      this.current = f.clone();
    }
    return this.current;
  }

  /** ScheduleEntry::next(): avanza _current (in place) alla prossima occorrenza. */
  next(): PhpDateTime | null {
    const current = this.getCurrent();
    if (!current) return null;
    switch (this.data.repeats) {
      case "daily":
        current.modify("+1 day");
        break;
      case "weekly":
        current.modify("+1 week");
        break;
      case "weekdays":
        current.modify("+1 weekday");
        break;
      case "weekends":
        current.modify("+1 day");
        break;
      case "monthly":
        // STRANEZZA PHP: dal 31 gennaio "+1 month" porta al 3 marzo, quindi febbraio è saltato
        current.modify("+1 month");
        break;
      case "yearly":
        current.modify("+1 year");
        break;
      case "never":
        return null;
    }
    this.applySpec(current);
    const stops = this.getStopsDatetime();
    if (stops && stops.getTimestamp() < current.getTimestamp()) return null;
    this.current = current;
    return current;
  }

  /** ScheduleEntry::getOccurrences($start, $end, $num=5): date 'Y-m-d' → voce, al massimo $num. */
  getOccurrences(start: PhpDateTime, end: string | null, num = 5): Map<string, ScheduleEntry> {
    const occurrences = new Map<string, ScheduleEntry>();
    let current = this.getCurrent(start);
    if (current) {
      const startDay = strtotimeDateUtc(start.format("Y-m-d"));
      const endDay = end ? strtotimeDateUtc(end) : null;
      while (occurrences.size < num) {
        const date = current.format("Y-m-d");
        if (endDay !== null && strtotimeDateUtc(date) > endDay) break;
        if (strtotimeDateUtc(date) >= startDay) occurrences.set(date, this);
        current = this.next();
        if (!current) break;
      }
    }
    return occurrences;
  }
}

/** `$a += $b` tra array PHP: aggiunge solo le chiavi mancanti (vince il primo). */
function unionInto<V>(target: Map<string, V>, source: Map<string, V>): void {
  for (const [k, v] of source) if (!target.has(k)) target.set(k, v);
}

/** ksort su chiavi 'Y-m-d' (stringhe non numeriche: confronto lessicografico). */
function ksort<V>(map: Map<string, V>): Map<string, V> {
  return new Map([...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** BusinessHours (include/class.businesshours.php). */
class BusinessHours {
  private workhours = new Map<string, ScheduleEntry>();
  private holidays = new Map<string, ScheduleEntry>();
  private readonly entries: ScheduleEntry[];
  private readonly holidayEntries: ScheduleEntry[][];
  readonly timeline: string[] = [];

  constructor(readonly schedule: ScheduleData) {
    // ScheduleEntry::objects() viene iterato più volte sugli stessi oggetti (stato _current condiviso)
    this.entries = schedule.entries.map((e) => new ScheduleEntry(e, schedule));
    this.holidayEntries = schedule.holidays.map((h) => h.entries.map((e) => new ScheduleEntry(e, h)));
  }

  private initOccurrences(date: PhpDateTime, gracePeriodHrs = 72): number {
    const dt = date.clone();
    // Si riparte dal giorno dopo se la data corrente è già stata elaborata
    if (this.workhours.has(dt.format("Y-m-d"))) dt.modify("+1 day");
    const period = dt.clone();
    period.modify(`+${gracePeriodHrs} hour`);

    let workhours = new Map<string, ScheduleEntry>();
    for (const entry of this.entries) unionInto(workhours, entry.getOccurrences(dt, period.format("Y-m-d")));
    workhours = ksort(workhours);
    this.workhours = workhours;
    // array_pop(array_keys(...)): null se non ci sono occorrenze (le festività restano senza limite)
    const keys = [...workhours.keys()];
    const enddate = keys.length ? keys[keys.length - 1] : null;
    const holidays = new Map<string, ScheduleEntry>();
    for (const entries of this.holidayEntries)
      for (const entry of entries) unionInto(holidays, entry.getOccurrences(dt, enddate));
    this.holidays = ksort(holidays);
    return workhours.size;
  }

  /**
   * BusinessHours::addWorkingHours: modifica `date` (come il PHP) e la restituisce nel fuso dello
   * schedule; false se lo schedule non ha voci. Con ore nulle/non numeriche restituisce la data
   * invariata (senza nemmeno cambiarne il fuso).
   */
  addWorkingHours(date: PhpDateTime, hours: number): PhpDateTime | false {
    if (!hours || !Number.isFinite(hours)) return date;
    if (!this.schedule.entries.length) return false;

    date.setTimezone(this.schedule.timezone);
    this.log(`*** Add ${Math.trunc(hours)} Working Hours to ${date.format("Y-m-d H:i:s")} ***`);
    const seconds = hours * 3600;
    let collected = 0;
    while (collected < seconds) {
      if (!this.initOccurrences(date)) break;
      for (const [d, e] of this.workhours) {
        let partial = false;
        if (d === date.format("Y-m-d")) {
          // Già fuori orario: si passa al prossimo giorno lavorativo
          if (e.isAfterHours(date)) continue;
          // Giornata già iniziata: si contano solo le ore rimanenti
          if (!e.isBeforeHours(date)) partial = true;
        } else if (strtotimeUtc(`${d} ${e.getEndsTime()}`) < date.getTimestamp()) {
          // STRANEZZA PHP: la fine giornata è interpretata in UTC (fuso PHP predefinito) e
          // confrontata con il timestamp reale
          continue;
        }

        let leadtime = 0;
        const holiday = this.holidays.get(d);
        if (holiday) {
          this.log(`${d} -> Skip ${holiday.getHours().toFixed(6)} Holiday Hours from ${holiday.schedule.name}`);
          // La data passa alla fine della festività
          date.modify(`${d} ${holiday.getEndsTime()}`);
          if (holiday.isFullDay()) continue;
          partial = true;
          // Recupero del tempo lavorativo prima dell'inizio della festività
          const hstarts = timeOfDaySeconds(holiday.getStartsTime());
          const dstarts = timeOfDaySeconds(e.getStartsTime());
          if (hstarts > dstarts) leadtime = hstarts - dstarts;
        }

        // STRANEZZA PHP: con una festività che finisce dopo l'orario il tempo aggiunto è negativo
        const time = partial ? e.diffTime(date) + leadtime : e.diff();
        collected += time;
        date.modify(`${d} ${e.getEndsTime()}`);
        this.log(`${d} -> Apply ${(time / 3600).toFixed(6)} Working Hours from ${e.data.name} - ${date.format("Y-m-d H:i:s")} (${Math.trunc(collected / 3600)})`);
        // STRANEZZA PHP: solo con ">" si torna indietro; se il conteggio è esattamente pari alla
        // richiesta si prosegue col giorno lavorativo successivo e poi si arretra di tutta la sua
        // durata (la scadenza cade all'inizio del giorno dopo invece che alla fine di quello pieno).
        if (collected > seconds) {
          const back = Math.trunc(phpRound(collected - seconds));
          date.subSeconds(back);
          this.log(`${d} -> Backtrack ${(back / 3600).toFixed(6)} Hours  ${date.format("Y-m-d H:i:s")} (${seconds / 3600})`);
          break;
        }
      }
    }
    this.log(`*** Final Datetime  ${date.format("Y-m-d H:i:s")} ***`);
    return date;
  }

  private log(line: string): void {
    this.timeline.push(line);
  }
}

/** round() di PHP: metà lontano da zero. */
export function phpRound(n: number): number {
  return n < 0 ? -Math.round(-n) : Math.round(n);
}

/** BusinessHoursSchedule::addWorkingHours: false se lo schedule non ha voci. */
export function addWorkingHours(
  schedule: ScheduleData,
  date: PhpDateTime,
  hours: number,
  timeline?: string[],
): PhpDateTime | false {
  const bhrs = new BusinessHours(schedule);
  if (!bhrs.addWorkingHours(date, hours)) return false;
  if (timeline) timeline.push(...bhrs.timeline);
  return date;
}

// ---------------------------------------------------------------------------------------------
// Caricamento dal DB

export interface ScheduleLoadOptions {
  /**
   * $cfg->getTimezone(), usato dagli schedule senza fuso ("floating"): fuso dell'agente/utente
   * della richiesta, altrimenti core.default_timezone. Se omesso vale core.default_timezone.
   */
  fallbackTimezone?: string | null;
}

/** $cfg->getTimezone() senza utente: core.default_timezone (poi ini date.timezone, qui UTC). */
async function resolveFallbackTimezone(
  userTimezone: string | null | undefined,
  executor: DbOrTx = db(),
): Promise<string> {
  if (userTimezone) return userTimezone;
  const core = await loadConfigNamespace("core", executor);
  // In PHP, senza default_timezone si userebbe ini_get('date.timezone') (vuoto nella CLI → eccezione)
  return core.str("default_timezone") || "UTC";
}

/**
 * Schedule::getTimezone(). Un fuso non valido non è segnalato qui ma al primo uso (PhpDateTime
 * lancia un'eccezione, come `new DateTimeZone()` in PHP), così come nel PHP uno schedule con fuso
 * errato non dà problemi finché non serve calcolare.
 */
function resolveZone(zone: string | null, fallback: string): string {
  return zone || fallback;
}

async function loadEntries(scheduleId: number, executor: DbOrTx): Promise<ScheduleEntryData[]> {
  // ScheduleEntry::objects()->filter(schedule_id): nessun ORDER BY nel PHP; InnoDB restituisce le
  // righe nell'ordine dell'indice schedule_id, cioè per id
  const rows = await executor
    .selectFrom("schedule_entry")
    .select(["id", "schedule_id", "name", "repeats", "starts_on", "starts_at", "ends_on", "ends_at", "stops_on", "day", "week", "month"])
    .where("schedule_id", "=", scheduleId)
    .orderBy("id")
    .execute();
  return rows.map((r) => ({
    id: r.id,
    scheduleId: r.schedule_id,
    name: r.name,
    repeats: r.repeats,
    startsOn: r.starts_on,
    startsAt: r.starts_at,
    endsOn: r.ends_on,
    endsAt: r.ends_at,
    stopsOn: r.stops_on,
    day: r.day === null ? null : Number(r.day),
    week: r.week === null ? null : Number(r.week),
    month: r.month === null ? null : Number(r.month),
  }));
}

async function loadScheduleRow(id: number, requireBizHours: boolean, executor: DbOrTx) {
  let q = executor.selectFrom("schedule").select(["id", "name", "flags", "timezone"]).where("id", "=", id);
  if (requireBizHours) q = q.where(sql<boolean>`(flags & ${ScheduleFlag.BIZHRS}) != 0`);
  return q.executeTakeFirst();
}

/** Schedule::getHolidays(): config `schedule.<id>`.configuration = {"holidays": [id, ...]} */
async function holidayIds(scheduleId: number, executor: DbOrTx): Promise<number[]> {
  const cfg = await loadConfigNamespace(`schedule.${scheduleId}`, executor);
  const conf = cfg.json<{ holidays?: unknown } | null>("configuration", null);
  const list = conf && conf.holidays ? conf.holidays : [];
  return (Array.isArray(list) ? list : Object.values(list as object)).map(Number).filter((n) => Number.isFinite(n) && n > 0);
}

/**
 * BusinessHoursSchedule::lookup($id): solo schedule con FLAG_BIZHRS, con voci e calendari
 * festività. STRANEZZA PHP: le festività sono caricate con HolidaysSchedule::lookup($id), che non
 * controlla il flag: anche uno schedule lavorativo elencato tra le festività vale come festività.
 */
export async function loadBusinessHoursSchedule(
  id: number,
  opts: ScheduleLoadOptions = {},
  executor: DbOrTx = db(),
): Promise<ScheduleData | null> {
  if (!id) return null;
  const row = await loadScheduleRow(id, true, executor);
  if (!row) return null;
  const fallback = opts.fallbackTimezone || (await resolveFallbackTimezone(null, executor));
  const holidays: ScheduleData[] = [];
  for (const hid of await holidayIds(row.id, executor)) {
    const h = await loadScheduleRow(hid, false, executor);
    if (!h) continue;
    holidays.push({
      id: h.id,
      name: h.name,
      flags: h.flags,
      timezone: resolveZone(h.timezone, fallback),
      entries: await loadEntries(h.id, executor),
      holidays: [],
    });
  }
  return {
    id: row.id,
    name: row.name,
    flags: row.flags,
    timezone: resolveZone(row.timezone, fallback),
    entries: await loadEntries(row.id, executor),
    holidays,
  };
}
