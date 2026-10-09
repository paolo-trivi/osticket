import { DateTime } from "luxon";

/**
 * Port di Misc::date_range() (include/class.misc.php) per i criteri "period" delle code.
 * Le stringhe di DateTime::modify() di PHP hanno semantiche particolari che vanno replicate:
 *  - "- 1 month" non tronca il giorno: 31 marzo − 1 mese = 31 febbraio → 3 marzo;
 *  - "last monday" da un lunedì torna al lunedì precedente (7 giorni prima);
 *  - "next sunday" da una domenica va alla domenica successiva.
 * I confini sono nel fuso dell'utente; il chiamante li converte nel fuso del DB.
 * Periodi: td, yd, tw, tm, tq, ty, lw, lm, lq, ly.
 */

/** Somma mesi come PHP: stesso giorno del mese, con overflow sui mesi più corti. */
function phpAddMonths(dt: DateTime, months: number): DateTime {
  const total = dt.year * 12 + (dt.month - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const first = dt.set({ year, month, day: 1 });
  return first.plus({ days: dt.day - 1 });
}

function phpAddYears(dt: DateTime, years: number): DateTime {
  return phpAddMonths(dt, years * 12);
}

/** "last monday": il lunedì precedente, mai il giorno stesso. */
function lastMonday(dt: DateTime): DateTime {
  const back = dt.weekday === 1 ? 7 : dt.weekday - 1;
  return dt.minus({ days: back });
}

/** "next sunday": la domenica successiva, mai il giorno stesso. */
function nextSunday(dt: DateTime): DateTime {
  const forward = dt.weekday === 7 ? 7 : 7 - dt.weekday;
  return dt.plus({ days: forward });
}

const firstOfMonth = (dt: DateTime) => dt.set({ day: 1 });
const lastOfMonth = (dt: DateTime) => dt.set({ day: dt.daysInMonth ?? 28 });

export function dateRange(period: string, now: DateTime): { start: DateTime; end: DateTime } | null {
  const dt = now;
  let start: DateTime;
  let end: DateTime;
  switch (period) {
    case "td":
    case "today":
      start = end = dt;
      break;
    case "yd":
    case "yesterday":
      start = end = dt.minus({ days: 1 });
      break;
    case "tw":
    case "this-week":
      start = dt.weekday === 1 ? dt : lastMonday(dt);
      end = nextSunday(start);
      break;
    case "tm":
    case "this-month":
      start = firstOfMonth(dt);
      end = lastOfMonth(dt);
      break;
    case "tq":
    case "this-quarter": {
      const offset = (dt.month - 1) % 3;
      start = firstOfMonth(phpAddMonths(dt, -offset));
      end = phpAddMonths(start, 3).minus({ days: 1 });
      break;
    }
    case "ty":
    case "this-year":
      // modify('january') imposta il mese mantenendo il giorno, poi primo/ultimo giorno del mese
      start = firstOfMonth(phpSetMonth(dt, 1));
      end = lastOfMonth(phpSetMonth(dt, 12));
      break;
    case "lw":
    case "last-week":
      start = lastMonday(dt.minus({ days: 7 }));
      end = nextSunday(start);
      break;
    case "lm":
    case "last-month":
      start = firstOfMonth(phpAddMonths(dt, -1));
      end = lastOfMonth(start);
      break;
    case "lq":
    case "last-quarter": {
      const offset = ((dt.month - 1) % 3) + 3;
      start = firstOfMonth(phpAddMonths(dt, -offset));
      end = phpAddMonths(start, 3).minus({ days: 1 });
      break;
    }
    case "ly":
    case "last-year":
      start = firstOfMonth(phpSetMonth(phpAddYears(dt, -1), 1));
      end = lastOfMonth(phpSetMonth(start, 12));
      break;
    default:
      return null;
  }
  return {
    start: start.set({ hour: 0, minute: 0, second: 0, millisecond: 0 }),
    end: end.set({ hour: 23, minute: 59, second: 59, millisecond: 0 }),
  };
}

/** modify('<nome mese>'): cambia il mese mantenendo il giorno (con overflow come PHP). */
function phpSetMonth(dt: DateTime, month: number): DateTime {
  return phpAddMonths(dt, month - dt.month);
}
