import "server-only";

import { Schedule } from "@/lib/osticket/flags";

import type { DbOrTx } from "../../db";
import { phpJsonEncode } from "../../format/php-json";
import { sanitizeText } from "../../format/text";
import { list, phpLooseEquals, str, truthy, type PhpVal, type PhpVars } from "../../php/values";
import { type MassResult, type SaveResult } from "./common";
import { ConfigWriter } from "./config-write";
import { OrmRow, SQL_NOW, setFlag } from "./orm";

/**
 * Orari: scp/schedules.php (update, eliminazione) e ajax.schedule.php (nuovo orario/clonazione,
 * voci, eliminazione voci) → Schedule / ScheduleEntry / ScheduleEntryForm (include/class.schedule.php).
 * Festività di un orario lavorativo in config "schedule.<id>" → configuration {"holidays":[…]}.
 *
 * Differenza: ajax.schedule.php richiede solo un agente autenticato (bug di permessi): qui solo admin.
 */

const OPTS = { touchUpdated: true };

export const FREQUENCIES = ["never", "daily", "weekly", "monthly", "yearly"] as const;
const WEEKS = ["1", "2", "3", "4", "5", "-1"];
const DAYS = ["1", "2", "3", "4", "5", "6", "7"];

/** Form base (Schedule::basicForm): nome obbligatorio, tipo obbligatorio tra bizhrs/hdays. */
function basicFormErrors(vars: PhpVars): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!str(vars.name).trim()) errors.name = "required";
  if (!["bizhrs", "hdays"].includes(str(vars.type))) errors.type = "required";
  return errors;
}

/** Nuovo orario (ajax.schedule.php add/clone): nome univoco, stesso tipo dell'orario clonato. */
export async function addSchedule(executor: DbOrTx, vars: PhpVars, cloneId?: number | null): Promise<SaveResult> {
  const errors = basicFormErrors(vars);
  if (Object.keys(errors).length) return { ok: false, errors };
  const name = str(vars.name);
  if (await executor.selectFrom("schedule").select("id").where("name", "=", name).executeTakeFirst()) return { ok: false, errors: { name: "in_use" } };
  const src = cloneId ? await executor.selectFrom("schedule").selectAll().where("id", "=", cloneId).executeTakeFirst() : undefined;
  if (src && ((src.flags & Schedule.BIZHRS) ? "bizhrs" : "hdays") !== str(vars.type)) return { ok: false, errors: { sid: "type" } };
  // Schedule::create($vars): salvato subito (created, updated, descrizione sanitizzata), poi il tipo
  const s = OrmRow.create("schedule", "id", OPTS);
  s.set("name", name);
  s.set("timezone", truthy(vars.timezone) ? str(vars.timezone) : null);
  s.set("description", sanitizeText(str(vars.description)));
  s.set("created", SQL_NOW);
  await s.save(executor);
  setFlag(s, Schedule.BIZHRS, str(vars.type) === "bizhrs");
  await s.save(executor);
  const id = s.num("id");
  if (src) {
    // cloneEntries: copia delle voci (created/updated = NOW)
    const entries = await executor.selectFrom("schedule_entry").selectAll().where("schedule_id", "=", src.id).execute();
    for (const e of entries) {
      const n = OrmRow.create("schedule_entry", "id", OPTS);
      for (const [k, v] of Object.entries(e)) if (k !== "id") n.set(k, v as never);
      n.set("schedule_id", id);
      n.set("created", SQL_NOW);
      await n.save(executor);
    }
  }
  return { ok: true, id, errors: {} };
}

/**
 * Schedule::update($vars): nome, fuso, descrizione; festività (config); ordinamento delle voci
 * (`sort-<id>` dal POST).
 */
export async function updateSchedule(executor: DbOrTx, scheduleId: number, vars: PhpVars): Promise<SaveResult> {
  const row = await OrmRow.load(executor, "schedule", "id", { id: scheduleId }, OPTS);
  if (!row) return { ok: false, errors: { err: "not_found" } };
  const errors = basicFormErrors(vars);
  if (Object.keys(errors).length) return { ok: false, errors };
  row.set("name", str(vars.name));
  row.set("timezone", truthy(vars.timezone) ? str(vars.timezone) : null);
  row.set("description", str(vars.description));
  // Schedule::save: descrizione modificata → Format::sanitize
  if (row.dirty.has("description")) row.set("description", sanitizeText(str(row.get("description") as PhpVal)));
  await row.save(executor);
  const cfg = await ConfigWriter.load(executor, `schedule.${scheduleId}`);
  const holidays = truthy(vars.holidays) ? list(vars.holidays) : [];
  await cfg.updateAll(executor, { configuration: phpJsonEncode({ holidays }) });
  const entries = await executor.selectFrom("schedule_entry").selectAll().where("schedule_id", "=", scheduleId).execute();
  for (const e of entries) {
    const k = `sort-${e.id}`;
    if (vars[k] === undefined || vars[k] === null) continue;
    const r = OrmRow.from("schedule_entry", "id", e, OPTS);
    r.set("sort", str(vars[k]));
    await r.save(executor);
  }
  return { ok: true, id: scheduleId, errors: {} };
}

/** Schedule::delete(): orario e sue voci (la config "schedule.<id>" resta, come nel PHP). */
export async function deleteSchedules(executor: DbOrTx, ids: number[]): Promise<MassResult> {
  let num = 0;
  for (const id of ids) {
    const res = await executor.deleteFrom("schedule").where("id", "=", id).executeTakeFirst();
    if (!Number(res.numDeletedRows)) continue;
    await executor.deleteFrom("schedule_entry").where("schedule_id", "=", id).execute();
    num++;
  }
  return { ok: num > 0, num, error: num ? undefined : "in_use" };
}

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

type EntryVars = Record<string, string | number | null>;

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

/** Fuso effettivo ($cfg->getTimezone()): quello dell'agente, poi quello di sistema. */
async function effectiveTimezone(executor: DbOrTx, staffId: number): Promise<string> {
  const s = await executor.selectFrom("staff").select("timezone").where("staff_id", "=", staffId).executeTakeFirst();
  if (s?.timezone) return s.timezone;
  const c = await executor.selectFrom("config").select("value").where("namespace", "=", "core").where("key", "=", "default_timezone").executeTakeFirst();
  return c?.value || "UTC";
}

function parseTime(v: string | undefined): [number, number] | null {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec((v ?? "").trim());
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return [+m[1], +m[2]];
}

/** ScheduleEntryForm::isValid() + process(): campi obbligatori visibili, poi i valori della voce. */
function processEntryForm(input: EntryInput, holidays: boolean, tz = "UTC"): { vars: EntryVars } | { errors: Record<string, string> } {
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

/** Schedule::isEntryUnique($vars, $errors) */
async function entryUniqueErrors(executor: DbOrTx, scheduleId: number, vars: EntryVars & { id?: number }): Promise<Record<string, string>> {
  const errors: Record<string, string> = {};
  const entries = await executor.selectFrom("schedule_entry").selectAll().where("schedule_id", "=", scheduleId).execute();
  const sameName = entries.find((x) => x.name === vars.name);
  if (!vars.name || (sameName && sameName.id !== (vars.id ?? 0))) errors.name = "unique";
  const has = (fn: (x: (typeof entries)[number]) => boolean) => entries.some(fn);
  switch (vars.repeats) {
    case "weekly":
      if (Number(vars.day) < 6) {
        if (has((x) => x.repeats === "weekdays")) errors.error = "weekdays_exists";
      } else if (Number(vars.day) > 5) {
        if (has((x) => x.repeats === "weekends")) errors.error = "weekends_exists";
      }
      break;
    case "weekdays":
      if (has((x) => x.repeats === "weekly" && (x.day ?? 0) < 6)) errors.error = "weekday_exists";
      break;
    case "weekends":
      if (has((x) => x.repeats === "weekly" && (x.day ?? 0) > 5)) errors.error = "weekend_exists";
      break;
    case "daily":
      if (!vars.id && entries.length) errors.error = "others_exist";
      break;
  }
  if (!errors.error && vars.repeats !== "daily" && has((x) => x.repeats === "daily")) errors.error = "daily_exists";
  if (!errors.error) {
    const keys = (["repeats", "day", "week", "month"] as const).filter((k) => k in vars);
    const match = entries.filter(
      (x) =>
        x.id !== vars.id &&
        keys.every((k) => (vars[k] === null ? x[k] === null : x[k] !== null && phpLooseEquals(x[k], vars[k] as never))) &&
        (vars.repeats !== "never" || phpLooseEquals(x.starts_on, vars.starts_on as never)),
    );
    if (match.length) errors.error = "exists";
  }
  return errors;
}

/** ajax.schedule.php addEntry / updateEntry */
export async function saveScheduleEntry(executor: DbOrTx, scheduleId: number, entryId: number | null, input: EntryInput, opts: { actorId: number }): Promise<SaveResult> {
  const sch = await executor.selectFrom("schedule").select(["id", "flags"]).where("id", "=", scheduleId).executeTakeFirst();
  if (!sch) return { ok: false, errors: { err: "not_found" } };
  const processed = processEntryForm(input, !(sch.flags & Schedule.BIZHRS), await effectiveTimezone(executor, opts.actorId));
  if ("errors" in processed) return { ok: false, errors: processed.errors };
  const vars = processed.vars;
  let row: OrmRow;
  if (entryId) {
    const r = await OrmRow.load(executor, "schedule_entry", "id", { id: entryId }, OPTS);
    if (!r || r.num("schedule_id") !== scheduleId) return { ok: false, errors: { err: "not_found" } };
    row = r;
  } else row = OrmRow.create("schedule_entry", "id", OPTS);
  const errors = await entryUniqueErrors(executor, scheduleId, entryId ? { ...vars, id: entryId } : vars);
  if (Object.keys(errors).length) return { ok: false, errors: entryId ? errors : { ...errors, error: errors.error ?? "unique" } };
  for (const [k, v] of Object.entries(vars)) row.set(k, v);
  if (!entryId) {
    row.set("schedule_id", scheduleId);
    row.set("created", SQL_NOW);
  }
  await row.save(executor);
  return { ok: true, id: row.num("id"), errors: {} };
}

/** ajax.schedule.php deleteEntries */
export async function deleteScheduleEntries(executor: DbOrTx, scheduleId: number, ids: number[]): Promise<number> {
  if (!ids.length) return 0;
  const res = await executor.deleteFrom("schedule_entry").where("schedule_id", "=", scheduleId).where("id", "in", ids).executeTakeFirst();
  return Number(res.numDeletedRows);
}

