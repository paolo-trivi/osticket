import "server-only";

import { IANAZone } from "luxon";

/**
 * Emulazione minimale di `DateTime` di PHP (timelib, PHP 8.3) limitata a ciò che serve al calcolo
 * delle scadenze SLA (include/class.businesshours.php, include/class.schedule.php).
 *
 * Il calcolo SLA di osTicket è fatto quasi interamente con `DateTime::modify()` su stringhe
 * relative ("Monday 2026-10-07", "+1 weekday", "First Monday of October 2026", ...), quindi
 * per ottenere risultati identici bisogna replicare:
 *  - l'aritmetica "da parete" di timelib (i campi y/m/d/h/i/s vengono modificati e poi normalizzati
 *    con overflow: 2026-02-31 → 2026-03-03, +1 month dal 31/01 → 03/03, ...);
 *  - la conversione ora locale → timestamp di timelib (`do_adjust_timezone`), che per le ore
 *    inesistenti (salto in avanti dell'ora legale) usa l'offset precedente (02:30 → 03:30) e per le
 *    ore ambigue (ritorno all'ora solare) sceglie in base al flag DST dell'oggetto PRIMA della
 *    modifica (`modify`/`setTime`), oppure, per il costruttore, in base al segno dell'offset;
 *  - `add()`/`sub()` di intervalli in secondi, che in PHP ≥ 8.1 sono tempo trascorso (non da parete).
 *
 * Il flag "is_dst" delle regole tzdata non è esposto da Intl: qui un offset è considerato DST se è
 * maggiore dell'offset minimo dell'anno (vale per tutti i fusi con DST "positivo"; differisce da PHP
 * solo per fusi con DST negativo come Europe/Dublin, e solo nelle ore ambigue).
 */

export interface LocalFields {
  y: number;
  m: number;
  d: number;
  h: number;
  i: number;
  s: number;
}

interface Transition {
  at: number; // timestamp (s) da cui vale il nuovo offset
}

interface OffsetInfo {
  offset: number; // secondi
  transition: number; // timestamp dell'ultima transizione <= ts (-Infinity se lontana/assente)
  isDst: boolean;
}

const DAY = 86400;

class ZoneRules {
  private readonly zone: IANAZone;
  private readonly years = new Map<number, { transitions: Transition[]; std: number }>();

  constructor(readonly name: string) {
    this.zone = IANAZone.create(name);
    if (!this.zone.isValid) throw new Error(`Fuso orario non valido: ${name}`);
  }

  offsetAt(ts: number): number {
    return Math.round(this.zone.offset(ts * 1000) * 60);
  }

  private year(y: number): { transitions: Transition[]; std: number } {
    let data = this.years.get(y);
    if (data) return data;
    const start = Date.UTC(y, 0, 1) / 1000;
    const end = Date.UTC(y + 1, 0, 1) / 1000;
    const transitions: Transition[] = [];
    let std = Infinity;
    let prevT = start - DAY;
    let prevOff = this.offsetAt(prevT);
    for (let t = start; ; t = Math.min(t + DAY, end)) {
      const off = this.offsetAt(t);
      if (t < end) std = Math.min(std, off);
      if (off !== prevOff) {
        // bisezione: primo secondo con il nuovo offset
        let lo = prevT;
        let hi = t;
        while (hi - lo > 1) {
          const mid = Math.floor((lo + hi) / 2);
          if (this.offsetAt(mid) === prevOff) lo = mid;
          else hi = mid;
        }
        if (hi >= start && hi < end) transitions.push({ at: hi });
      }
      prevT = t;
      prevOff = off;
      if (t >= end) break;
    }
    data = { transitions, std };
    this.years.set(y, data);
    return data;
  }

  info(ts: number): OffsetInfo {
    const offset = this.offsetAt(ts);
    const y = new Date(ts * 1000).getUTCFullYear();
    const cur = this.year(y);
    let transition = -Infinity;
    for (const yy of [y, y - 1]) {
      const list = this.year(yy).transitions;
      for (let k = list.length - 1; k >= 0; k--) {
        if (list[k].at <= ts) {
          transition = list[k].at;
          break;
        }
      }
      if (transition !== -Infinity) break;
    }
    return { offset, transition, isDst: offset > cur.std };
  }
}

const zones = new Map<string, ZoneRules>();
function rules(zone: string): ZoneRules {
  let r = zones.get(zone);
  if (!r) {
    r = new ZoneRules(zone);
    zones.set(zone, r);
  }
  return r;
}

/** Il fuso è utilizzabile (equivalente di `new DateTimeZone($tz)` che non lancia eccezioni). */
export function isValidZone(zone: string | null | undefined): zone is string {
  if (!zone) return false;
  try {
    rules(zone);
    return true;
  } catch {
    return false;
  }
}

/** Campi "da parete" interpretati come UTC (timelib: `sse` prima dell'aggiustamento del fuso). */
export function fieldsToSse(f: LocalFields): number {
  // setUTCFullYear/setUTCHours normalizzano l'overflow (31 febbraio → 3 marzo) come timelib
  // e, a differenza di Date.UTC, non trattano gli anni 0-99 come 1900+
  const d = new Date(0);
  d.setUTCFullYear(f.y, f.m - 1, f.d);
  d.setUTCHours(f.h, f.i, f.s, 0);
  return Math.floor(d.getTime() / 1000);
}

function sseToFields(sse: number): LocalFields {
  const d = new Date(sse * 1000);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    i: d.getUTCMinutes(),
    s: d.getUTCSeconds(),
  };
}

/**
 * timelib `do_adjust_timezone` (tm2unixtime.c) per fusi di tipo ID.
 * `dstHint`: flag DST dell'oggetto prima della modifica (`have_zone`), undefined per il costruttore.
 */
function localToTimestamp(sse: number, zone: string, dstHint: boolean | undefined): number {
  const r = rules(zone);
  const current = r.info(sse);
  const after = r.info(sse - current.offset);
  let actualOffset = after.offset;
  let actualTransition = after.transition;
  if (current.offset === after.offset && dstHint !== undefined) {
    if (current.offset >= 0 && dstHint && !current.isDst) {
      const earlier = r.info(sse - current.offset - 7200);
      if (earlier.offset !== after.offset && sse - earlier.offset < after.transition) {
        actualOffset = earlier.offset;
        actualTransition = earlier.transition;
      }
    } else if (current.offset <= 0 && current.isDst && !dstHint) {
      const later = r.info(sse - current.offset + 7200);
      if (later.offset !== after.offset && sse - later.offset >= later.transition) {
        actualOffset = later.offset;
        actualTransition = later.transition;
      }
    }
  }
  const inTransition =
    actualTransition !== -Infinity &&
    sse - actualOffset >= actualTransition + (current.offset - actualOffset) &&
    sse - actualOffset < actualTransition;
  const adjustment = current.offset !== actualOffset && !inTransition ? -actualOffset : -current.offset;
  return sse + adjustment;
}

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const ORDINALS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, next: 1, last: -1 };
const MONTH_LABELS = MONTH_NAMES.map((m) => m[0].toUpperCase() + m.slice(1));

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** Giorno della settimana (0 = domenica) di una data civile. */
function dayOfWeek(y: number, m: number, d: number): number {
  return new Date(fieldsToSse({ y, m, d, h: 0, i: 0, s: 0 }) * 1000).getUTCDay();
}

const DATE_RE = "(\\d{4})-(\\d{1,2})-(\\d{1,2})";
const DAY_RE = `(${DAY_NAMES.join("|")})`;
const MONTH_RE = `(${MONTH_NAMES.join("|")})`;
const ORD_RE = "(first|second|third|fourth|fifth|last|next)";

/**
 * Mutabile come `DateTime` di PHP: i metodi modificano l'istanza (serve a replicare il codice PHP,
 * che conta sugli effetti collaterali, es. ScheduleEntry::next()).
 */
export class PhpDateTime {
  private constructor(
    private ts: number,
    private tz: string,
  ) {}

  /** `new DateTime($str, new DateTimeZone($zone))` con $str 'Y-m-d', 'Y-m-d H:i:s' o 'Y-m-d H:i'. */
  static create(str: string, zone: string): PhpDateTime {
    const m = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*$/.exec(str);
    if (!m) throw new Error(`Formato data non supportato: "${str}"`);
    const f: LocalFields = {
      y: Number(m[1]),
      m: Number(m[2]),
      d: Number(m[3]),
      h: Number(m[4] ?? 0),
      i: Number(m[5] ?? 0),
      s: Number(m[6] ?? 0),
    };
    return new PhpDateTime(localToTimestamp(fieldsToSse(f), zone, undefined), zone);
  }

  static fromTimestamp(ts: number, zone: string): PhpDateTime {
    rules(zone);
    return new PhpDateTime(ts, zone);
  }

  clone(): PhpDateTime {
    return new PhpDateTime(this.ts, this.tz);
  }

  getTimestamp(): number {
    return this.ts;
  }

  get timezone(): string {
    return this.tz;
  }

  getOffset(): number {
    return rules(this.tz).offsetAt(this.ts);
  }

  isDst(): boolean {
    return rules(this.tz).info(this.ts).isDst;
  }

  fields(): LocalFields {
    return sseToFields(this.ts + this.getOffset());
  }

  /** Sottoinsieme di `DateTime::format`: Y m d H i s N F j n, il resto è copiato. */
  format(fmt: string): string {
    const f = this.fields();
    let out = "";
    for (const ch of fmt) {
      switch (ch) {
        case "Y":
          out += pad(f.y, 4);
          break;
        case "m":
          out += pad(f.m);
          break;
        case "n":
          out += String(f.m);
          break;
        case "d":
          out += pad(f.d);
          break;
        case "j":
          out += String(f.d);
          break;
        case "H":
          out += pad(f.h);
          break;
        case "i":
          out += pad(f.i);
          break;
        case "s":
          out += pad(f.s);
          break;
        case "N":
          out += String(dayOfWeek(f.y, f.m, f.d) || 7);
          break;
        case "F":
          out += MONTH_LABELS[f.m - 1];
          break;
        default:
          out += ch;
      }
    }
    return out;
  }

  setTimezone(zone: string): this {
    rules(zone);
    this.tz = zone;
    return this;
  }

  /** Imposta i campi locali e ricalcola il timestamp come `timelib_update_ts` (flag DST come suggerimento). */
  private setFields(f: LocalFields): this {
    this.ts = localToTimestamp(fieldsToSse(f), this.tz, this.isDst());
    return this;
  }

  setTime(h: number, i: number, s: number): this {
    const f = this.fields();
    return this.setFields({ ...f, h, i, s });
  }

  /** `add(new DateInterval('PT{n}S'))`: tempo trascorso (PHP ≥ 8.1). */
  addSeconds(n: number): this {
    this.ts += n;
    return this;
  }

  /** `sub(new DateInterval('PT{n}S'))`. */
  subSeconds(n: number): this {
    this.ts -= n;
    return this;
  }

  /**
   * `DateTime::modify()` per le sole forme usate da osTicket nel calcolo SLA. Restituisce false
   * (data invariata, come PHP con un warning) se la stringa non è riconosciuta.
   */
  modify(spec: string): boolean {
    const s = spec.trim().replace(/\s+/g, " ").toLowerCase();
    const f = this.fields();
    let m: RegExpExecArray | null;
    let next: LocalFields | null = null;

    // "Y-m-d H:i:s": data e ora assolute
    if ((m = new RegExp(`^${DATE_RE} (\\d{1,2}):(\\d{2}):(\\d{2})$`).exec(s))) {
      next = { y: +m[1], m: +m[2], d: +m[3], h: +m[4], i: +m[5], s: +m[6] };
    }
    // "Y-m-d": solo la data, l'ora resta invariata (ScheduleEntry 'never' e 'monthly' per giorno)
    else if ((m = new RegExp(`^${DATE_RE}$`).exec(s))) {
      next = { ...f, y: +m[1], m: +m[2], d: +m[3] };
    }
    // "today Y-m-d": data a mezzanotte
    else if ((m = new RegExp(`^today ${DATE_RE}$`).exec(s))) {
      next = { y: +m[1], m: +m[2], d: +m[3], h: 0, i: 0, s: 0 };
    }
    // "weekday" (senza numero): per timelib è il giorno della settimana 1 (lunedì), alle 00:00,
    // cioè "lunedì da oggi in poi"
    else if (s === "weekday" || s === "weekdays") {
      next = this.weekdayOnOrAfter({ ...f, h: 0, i: 0, s: 0 }, 1, 1);
    }
    // "<Giorno> Y-m-d": giorno della settimana a partire dalla data (inclusa), alle 00:00
    else if ((m = new RegExp(`^${DAY_RE} ${DATE_RE}$`).exec(s))) {
      const base = { y: +m[2], m: +m[3], d: +m[4], h: 0, i: 0, s: 0 };
      next = this.weekdayOnOrAfter(base, DAY_NAMES.indexOf(m[1]), 1);
    }
    // "Next <Giorno> Y-m-d": giorno della settimana strettamente successivo, alle 00:00
    else if ((m = new RegExp(`^next ${DAY_RE} ${DATE_RE}$`).exec(s))) {
      const base = { y: +m[2], m: +m[3], d: +m[4], h: 0, i: 0, s: 0 };
      next = this.weekdayOnOrAfter(base, DAY_NAMES.indexOf(m[1]), 0);
    }
    // "<N-esimo|Last> <Giorno> of <Mese> <Anno>" (timelib weekdayof)
    else if ((m = new RegExp(`^${ORD_RE} ${DAY_RE} of ${MONTH_RE} (\\d{4})$`).exec(s))) {
      const n = ORDINALS[m[1]];
      const wd = DAY_NAMES.indexOf(m[2]);
      const month = MONTH_NAMES.indexOf(m[3]) + 1;
      const year = +m[4];
      if (n > 0) {
        // giorno 1 del mese, poi il giorno della settimana dal giorno 1 incluso + (n-1) settimane
        const first = this.weekdayOnOrAfter({ y: year, m: month, d: 1, h: 0, i: 0, s: 0 }, wd, 1);
        next = { ...first, d: first.d + (n - 1) * 7 };
      } else {
        // giorno 1 del mese successivo, -7 giorni, poi il giorno della settimana da lì incluso
        const base = { y: year, m: month + 1, d: 1, h: 0, i: 0, s: 0 };
        const dow = dayOfWeek(...normYmd(base));
        let diff = wd - dow;
        if (diff < 0) diff += 7;
        next = { ...base, d: base.d + diff - 7 };
      }
    }
    // "<Mese> <Anno> <N-esimo> <Giorno>" (ScheduleEntry yearly con settimana > 0): "Mese Anno" porta
    // al giorno 1, poi "+N <giorno>" cerca il giorno STRETTAMENTE successivo al giorno 1 (+ (N-1)
    // settimane). Stranezza PHP: se il mese inizia proprio con quel giorno, il giorno 1 è saltato.
    else if ((m = new RegExp(`^${MONTH_RE} (\\d{4}) ${ORD_RE} ${DAY_RE}$`).exec(s))) {
      const month = MONTH_NAMES.indexOf(m[1]) + 1;
      const year = +m[2];
      const n = ORDINALS[m[3]];
      const wd = DAY_NAMES.indexOf(m[4]);
      const base = { y: year, m: month, d: 1, h: 0, i: 0, s: 0 };
      next = this.relativeWeekday(base, wd, n);
    }
    // "<Mese> <giorno> <Anno>": solo la data, l'ora resta invariata
    else if ((m = new RegExp(`^${MONTH_RE} (\\d{1,2}) (\\d{4})$`).exec(s))) {
      next = { ...f, y: +m[3], m: MONTH_NAMES.indexOf(m[1]) + 1, d: +m[2] };
    }
    // relativi "+N unità"
    else if ((m = /^([+-]?\d+) (day|days|week|weeks|weekday|weekdays|month|months|year|years|hour|hours)$/.exec(s))) {
      const n = Number(m[1]);
      const unit = m[2].replace(/s$/, "");
      switch (unit) {
        case "day":
          next = { ...f, d: f.d + n };
          break;
        case "week":
          next = { ...f, d: f.d + 7 * n };
          break;
        case "month":
          next = { ...f, m: f.m + n };
          break;
        case "year":
          next = { ...f, y: f.y + n };
          break;
        case "hour":
          // da parete (timelib somma ai campi e poi normalizza)
          next = { ...f, h: f.h + n };
          break;
        case "weekday":
          next = addWeekdays(f, n);
          break;
      }
    }
    if (!next) return false;
    this.setFields(next);
    return true;
  }

  /** timelib do_adjust_for_weekday con relative.d = 0: behavior 1 = dal giorno incluso, 0 = successivo. */
  private weekdayOnOrAfter(f: LocalFields, weekday: number, behavior: 0 | 1): LocalFields {
    const [y, mo, d] = normYmd(f);
    const dow = dayOfWeek(y, mo, d);
    let diff = weekday - dow;
    if (diff <= -behavior) diff += 7;
    return { ...f, y, m: mo, d: d + diff };
  }

  /** "+N <giorno>" (behavior 0): giorno strettamente successivo + (N-1) settimane. */
  private relativeWeekday(f: LocalFields, weekday: number, n: number): LocalFields {
    const [y, mo, d] = normYmd(f);
    const dow = dayOfWeek(y, mo, d);
    const reld = (n > 0 ? n - 1 : n) * 7;
    let diff = weekday - dow;
    if ((reld < 0 && diff < 0) || (reld >= 0 && diff <= 0)) diff += 7;
    return { ...f, y, m: mo, d: d + diff + reld };
  }
}

function normYmd(f: Pick<LocalFields, "y" | "m" | "d">): [number, number, number] {
  const n = sseToFields(fieldsToSse({ y: f.y, m: f.m, d: f.d, h: 0, i: 0, s: 0 }));
  return [n.y, n.m, n.d];
}

/** "+N weekday" di timelib (solo N >= 0, l'unico caso usato: +1 weekday). Mantiene l'ora. */
function addWeekdays(f: LocalFields, n: number): LocalFields {
  const [y, m, d0] = normYmd(f);
  let d = d0;
  let dow = dayOfWeek(y, m, d);
  if (n <= 0) {
    // non usato da osTicket; comportamento approssimato
    return { ...f, y, m, d: d + n };
  }
  // da sabato/domenica si riparte dal venerdì precedente
  if (dow === 6) {
    d -= 1;
    dow = 5;
  } else if (dow === 0) {
    d -= 2;
    dow = 5;
  }
  let left = n;
  while (left > 0) {
    d += 1;
    dow = (dow + 1) % 7;
    if (dow !== 0 && dow !== 6) left--;
  }
  return { ...f, y, m, d };
}

/** `strtotime("Y-m-d H:i:s")` con il fuso predefinito di PHP, che osTicket fissa a UTC (bootstrap.php). */
export function strtotimeUtc(dateTime: string): number {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2}) (\d{1,2}):(\d{2}):(\d{2})$/.exec(dateTime.trim());
  if (!m) throw new Error(`strtotime non supportato: "${dateTime}"`);
  return fieldsToSse({ y: +m[1], m: +m[2], d: +m[3], h: +m[4], i: +m[5], s: +m[6] });
}

/**
 * `strtotime("H:i:s")`: oggi alle H:i:s in UTC. Usato solo per confronti/differenze tra orari dello
 * stesso giorno, quindi bastano i secondi dalla mezzanotte (UTC non ha ora legale).
 */
export function timeOfDaySeconds(time: string): number {
  const [h, i, s] = time.split(":").map(Number);
  return h * 3600 + i * 60 + (s || 0);
}

/** `strtotime("Y-m-d")` in UTC (confronti tra date). */
export function strtotimeDateUtc(date: string): number {
  return strtotimeUtc(`${date} 00:00:00`);
}
