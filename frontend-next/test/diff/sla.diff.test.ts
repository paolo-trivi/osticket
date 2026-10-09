import { spawn } from "node:child_process";

import { createConnection } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadConfigNamespace } from "@/server/config/config";
import { closeDb, db } from "@/server/db";
import { detectDbTimezone } from "@/server/db/time";
import { PhpDateTime } from "@/server/domain/sla/php-datetime";
import type { ScheduleData } from "@/server/domain/sla/schedule";
import { addGracePeriod, loadSla, resolveSlaSchedule, slaDueDate } from "@/server/domain/sla/sla";
import { installConfig } from "@/server/env";

import { OST_ROOT, PHP_DB, TS_DB, prepareSnapshot, resetWorkingDatabases } from "./lib/harness";

/**
 * Scadenze SLA: SLA::addGracePeriod / BusinessHoursSchedule::addWorkingHours / Ticket::getSLADueDate
 * calcolati dal PHP originale (test/diff/php/sla-runner.php) e dal TypeScript devono coincidere al
 * secondo, su schedule realistici (orari d'ufficio, 24/7, festività fisse/mobili/parziali, fusi
 * diversi, voci mensili/annuali) e su date di partenza "difficili" (weekend, sere, cambi d'ora
 * legale di marzo/ottobre, fine mese, festività).
 */

// ---------------------------------------------------------------------------------------------
// Dati di prova (inseriti identici nei due DB di lavoro, nel formato che scriverebbe il PHP)

type EntryDef = {
  name: string;
  repeats: string;
  starts_on: string;
  starts_at: string;
  ends_at: string;
  stops_on?: string | null;
  day?: number | null;
  week?: number | null;
  month?: number | null;
};
type ScheduleDef = { id: number; flags: number; name: string; timezone: string | null; holidays?: number[]; entries: EntryDef[] };

const ALLDAY = { starts_at: "00:00:00", ends_at: "23:59:59" };
const weekly = (from: number, to: number, startsAt: string, endsAt: string): EntryDef[] =>
  // 2019-01-07 è un lunedì: starts_on è la data del giorno della settimana, come nel form PHP
  Array.from({ length: to - from + 1 }, (_, k) => {
    const day = from + k;
    return {
      name: `Giorno ${day}`,
      repeats: "weekly",
      starts_on: `2019-01-${String(6 + day).padStart(2, "0")}`,
      starts_at: startsAt,
      ends_at: endsAt,
      day,
    };
  });
const fixedHoliday = (name: string, month: number, day: number): EntryDef => ({
  name,
  repeats: "yearly",
  starts_on: `2019-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  ...ALLDAY,
  day,
  week: null,
  month,
});

const SCHEDULES: ScheduleDef[] = [
  {
    // fuso "floating": usa core.default_timezone (Europe/Rome)
    id: 101,
    flags: 1,
    name: "Lun-Ven 8-17 (fuso di sistema) + festività IT",
    timezone: null,
    holidays: [104],
    entries: weekly(1, 5, "08:00:00", "17:00:00"),
  },
  {
    id: 102,
    flags: 1,
    name: "24/7 Roma",
    timezone: "Europe/Rome",
    entries: [{ name: "Tutti i giorni", repeats: "daily", starts_on: "2019-01-01", ...ALLDAY }],
  },
  {
    id: 103,
    flags: 1,
    name: "New York 9-18:30 + festività USA",
    timezone: "America/New_York",
    holidays: [4],
    entries: [{ name: "Feriali", repeats: "weekdays", starts_on: "2019-01-01", starts_at: "09:00:00", ends_at: "18:30:59" }],
  },
  {
    id: 104,
    flags: 0,
    name: "Festività italiane",
    timezone: "Europe/Rome",
    entries: [
      fixedHoliday("Capodanno", 1, 1),
      fixedHoliday("Epifania", 1, 6),
      fixedHoliday("Liberazione", 4, 25),
      fixedHoliday("Lavoro", 5, 1),
      fixedHoliday("Repubblica", 6, 2),
      fixedHoliday("Ferragosto", 8, 15),
      fixedHoliday("Ognissanti", 11, 1),
      fixedHoliday("Immacolata", 12, 8),
      fixedHoliday("Natale", 12, 25),
      fixedHoliday("Santo Stefano", 12, 26),
      { name: "Pasquetta 2026", repeats: "never", starts_on: "2026-04-06", ...ALLDAY },
      // chiusura anticipata (festività parziale: si recupera il tempo prima dell'inizio)
      { name: "Chiusura anticipata", repeats: "never", starts_on: "2026-10-30", starts_at: "14:00:00", ends_at: "18:00:00" },
      // pausa a metà mattina (festività che inizia dopo l'apertura e finisce prima della chiusura)
      { name: "Assemblea", repeats: "never", starts_on: "2026-03-30", starts_at: "10:00:00", ends_at: "12:00:59" },
      // ultimo venerdì del mese, pomeriggio
      { name: "Inventario", repeats: "monthly", starts_on: "2019-01-25", starts_at: "15:00:00", ends_at: "17:00:00", day: 5, week: -1 },
      // secondo mercoledì di novembre (festa aziendale), giornata intera
      { name: "Festa aziendale", repeats: "yearly", starts_on: "2019-11-13", ...ALLDAY, day: 3, week: 2, month: 11 },
    ],
  },
  {
    id: 105,
    flags: 1,
    name: "Roma feriali 8:30-17:30 + sabato mattina",
    timezone: "Europe/Rome",
    holidays: [104],
    entries: [
      { name: "Feriali", repeats: "weekdays", starts_on: "2019-01-01", starts_at: "08:30:00", ends_at: "17:30:59" },
      { name: "Sabato", repeats: "weekly", starts_on: "2019-01-05", starts_at: "09:00:00", ends_at: "12:00:00", day: 6 },
    ],
  },
  {
    id: 106,
    flags: 1,
    name: "Sydney Lun-Ven 8-17",
    timezone: "Australia/Sydney",
    entries: weekly(1, 5, "08:00:00", "17:00:00"),
  },
  { id: 107, flags: 1, name: "Senza voci", timezone: "Europe/Rome", entries: [] },
  {
    id: 108,
    flags: 1,
    name: "Mensile/annuale/weekend",
    timezone: "Europe/Rome",
    holidays: [104],
    entries: [
      { name: "Fine mese", repeats: "monthly", starts_on: "2019-01-31", starts_at: "10:00:00", ends_at: "16:00:00", day: 31 },
      { name: "Secondo martedì", repeats: "monthly", starts_on: "2019-01-08", starts_at: "09:00:00", ends_at: "17:00:00", day: 2, week: 2 },
      { name: "Primo lunedì di giugno", repeats: "yearly", starts_on: "2019-06-03", starts_at: "08:00:00", ends_at: "12:00:00", day: 1, week: 1, month: 6 },
      { name: "29 febbraio", repeats: "yearly", starts_on: "2020-02-29", starts_at: "08:00:00", ends_at: "18:00:00", day: 29, month: 2 },
      { name: "Weekend", repeats: "weekends", starts_on: "2019-01-05", starts_at: "10:00:00", ends_at: "14:00:00", stops_on: "2026-12-31 00:00:00" },
      { name: "Giornata speciale", repeats: "never", starts_on: "2026-10-28", starts_at: "08:00:00", ends_at: "20:00:00" },
      { name: "Primo mercoledì", repeats: "monthly", starts_on: "2019-01-02", starts_at: "07:00:00", ends_at: "19:30:59", day: 3, week: 1 },
    ],
  },
  {
    id: 109,
    flags: 1,
    name: "Kolkata 24/5 + festività IT (fuso diverso)",
    timezone: "Asia/Kolkata",
    holidays: [104],
    entries: [{ name: "Feriali", repeats: "weekdays", starts_on: "2019-01-01", ...ALLDAY }],
  },
  // calendario festività usato per sbaglio come orario di un reparto: BusinessHoursSchedule::lookup fallisce
  { id: 110, flags: 0, name: "Festività (non lavorativo)", timezone: null, entries: [fixedHoliday("Natale", 12, 25)] },
];

// grace_period è INT: 0.5 viene arrotondato da MySQL (SQL_MODE '') esattamente come per il PHP
const SLAS = [
  { id: 101, name: "SLA 8h", grace: "8", flags: 3, schedule: 0 },
  { id: 102, name: "SLA 24h 24/7", grace: "24", flags: 1, schedule: 102 },
  { id: 103, name: "SLA mezz'ora", grace: "0.5", flags: 1, schedule: 0 },
  { id: 104, name: "SLA 72h Roma", grace: "72", flags: 1, schedule: 105 },
  { id: 105, name: "SLA inattivo", grace: "8", flags: 0, schedule: 0 },
  { id: 106, name: "SLA zero", grace: "0", flags: 1, schedule: 0 },
  { id: 107, name: "SLA 9h esatte", grace: "9", flags: 1, schedule: 101 },
  { id: 108, name: "SLA 300h mensile", grace: "300", flags: 1, schedule: 108 },
];

/** reparti: 1 senza schedule, 2 → New York, 3 → schedule non lavorativo, 104 → senza voci, 105 → Sydney */
const DEPT_SCHEDULES: Record<number, number> = { 1: 0, 2: 103, 3: 110 };
const NEW_DEPTS = [
  { id: 104, name: "Reparto senza voci", schedule: 107 },
  { id: 105, name: "Reparto Sydney", schedule: 106 },
];

async function seed(dbName: string): Promise<void> {
  const cfg = installConfig();
  const p = cfg.tablePrefix;
  const conn = await createConnection({
    host: cfg.dbHost,
    port: cfg.dbPort,
    user: cfg.dbUser,
    password: cfg.dbPass,
    database: dbName,
    dateStrings: true,
  });
  try {
    await conn.query("SET SESSION SQL_MODE = ''");
    for (const s of SCHEDULES) {
      await conn.query(
        `INSERT INTO ${p}schedule (id, flags, name, timezone, description, created, updated) VALUES (?, ?, ?, ?, '', NOW(), NOW())`,
        [s.id, s.flags, s.name, s.timezone],
      );
      for (const e of s.entries) {
        await conn.query(
          `INSERT INTO ${p}schedule_entry (schedule_id, flags, sort, name, repeats, starts_on, starts_at, ends_on, ends_at, stops_on, day, week, month, created, updated)
           VALUES (?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
          [s.id, e.name, e.repeats, e.starts_on, e.starts_at, e.starts_on, e.ends_at, e.stops_on ?? null, e.day ?? null, e.week ?? null, e.month ?? null],
        );
      }
      if (s.holidays)
        await conn.query(`INSERT INTO ${p}config (namespace, \`key\`, value, updated) VALUES (?, 'configuration', ?, NOW())`, [
          `schedule.${s.id}`,
          JSON.stringify({ holidays: s.holidays }),
        ]);
    }
    for (const s of SLAS)
      await conn.query(
        `INSERT INTO ${p}sla (id, schedule_id, flags, grace_period, name, notes, created, updated) VALUES (?, ?, ?, ?, ?, '', NOW(), NOW())`,
        [s.id, s.schedule, s.flags, s.grace, s.name],
      );
    for (const [id, schedule] of Object.entries(DEPT_SCHEDULES))
      await conn.query(`UPDATE ${p}department SET schedule_id = ? WHERE id = ?`, [schedule, Number(id)]);
    for (const d of NEW_DEPTS)
      await conn.query(
        `INSERT INTO ${p}department (id, name, signature, path, schedule_id, created, updated) VALUES (?, ?, '', ?, ?, NOW(), NOW())`,
        [d.id, d.name, `/${d.id}/`, d.schedule],
      );
  } finally {
    await conn.end();
  }
}

async function setDbTimezone(dbName: string, zone: string | null): Promise<void> {
  const cfg = installConfig();
  const conn = await createConnection({ host: cfg.dbHost, port: cfg.dbPort, user: cfg.dbUser, password: cfg.dbPass, database: dbName });
  try {
    await conn.query(`DELETE FROM ${cfg.tablePrefix}config WHERE namespace = 'core' AND \`key\` = 'db_timezone'`);
    if (zone)
      await conn.query(`INSERT INTO ${cfg.tablePrefix}config (namespace, \`key\`, value, updated) VALUES ('core', 'db_timezone', ?, NOW())`, [zone]);
  } finally {
    await conn.end();
  }
}

// ---------------------------------------------------------------------------------------------
// Casi

const BASE_DAYS = [
  "2026-01-01", // festività (giovedì)
  "2026-01-02",
  "2026-01-30", // venerdì, fine mese
  "2026-01-31", // sabato, fine mese
  "2026-02-27",
  "2026-02-28",
  "2026-03-06",
  "2026-03-07", // weekend prima del cambio d'ora USA (8 marzo)
  "2026-03-08",
  "2026-03-27", // venerdì prima del cambio d'ora europeo (29 marzo)
  "2026-03-28",
  "2026-03-29",
  "2026-03-30", // lunedì con festività parziale (assemblea 10-12)
  "2026-04-03", // venerdì prima di Pasquetta e del cambio d'ora di Sydney (5 aprile)
  "2026-04-24", // venerdì prima del 25 aprile
  "2026-04-30",
  "2026-05-29", // ultimo venerdì (inventario 15-17)
  "2026-06-01", // primo lunedì di giugno (stranezza "June 2026 First Monday")
  "2026-07-31",
  "2026-08-14",
  "2026-10-02", // venerdì prima del cambio d'ora di Sydney (4 ottobre)
  "2026-10-23", // venerdì prima del cambio d'ora europeo (25 ottobre)
  "2026-10-24",
  "2026-10-25",
  "2026-10-26",
  "2026-10-28", // giornata speciale dello schedule 108
  "2026-10-30", // chiusura anticipata 14-18 + ultimo venerdì
  "2026-10-31",
  "2026-11-11", // Veterans day (USA) / secondo mercoledì
  "2026-11-25", // prima del Thanksgiving
  "2026-12-23",
  "2026-12-24",
  "2026-12-31",
  "2027-02-26",
];
const TIMES = ["00:00:00", "02:30:00", "07:59:59", "08:00:00", "09:15:30", "12:34:56", "16:59:59", "17:00:00", "17:00:01", "19:45:00", "23:59:59"];
const SHORT_TIMES = ["02:30:00", "08:00:00", "12:34:56", "17:00:01", "23:59:59"];

type GraceCase = { kind: "grace"; slaId: number; grace: number; scheduleId: number | null; start: string; tz: string };
type TicketCase = { kind: "ticket"; slaId: number; deptId: number; created: string; reopened: string | null };
type GraceResult = { date: string; zone: string; ts: number } | { error: string };
type TicketResult = { due: string | null } | { error: string };

function graceCases(): GraceCase[] {
  const cases: GraceCase[] = [];
  const schedules: (number | null)[] = [null, 1, 2, 3, 101, 102, 103, 105, 106, 107, 108, 109];
  const graces = [8, 24, 72, 0.5, 9, 1.25, 0];
  for (const scheduleId of schedules)
    for (const grace of graces)
      for (const day of BASE_DAYS) {
        const times = grace === 8 || grace === 24 || grace === 0.5 ? TIMES : SHORT_TIMES;
        for (const time of times) cases.push({ kind: "grace", slaId: 101, grace, scheduleId, start: `${day} ${time}`, tz: "UTC" });
      }
  // data di partenza in fusi diversi (anche ore inesistenti/ambigue del cambio d'ora)
  for (const tz of ["Europe/Rome", "America/New_York"])
    for (const scheduleId of [101, 102, 103, 105, 108])
      for (const day of BASE_DAYS)
        for (const time of ["01:30:00", "02:30:00", "08:00:00", "17:00:01"])
          cases.push({ kind: "grace", slaId: 101, grace: 24, scheduleId, start: `${day} ${time}`, tz });
  // periodi lunghi (molte iterazioni di initOccurrences, festività, voci mensili/annuali)
  for (const scheduleId of [101, 103, 105, 108, 109])
    for (const day of BASE_DAYS) cases.push({ kind: "grace", slaId: 101, grace: 300, scheduleId, start: `${day} 10:00:00`, tz: "UTC" });
  return cases;
}

function ticketCases(): TicketCase[] {
  const cases: TicketCase[] = [];
  const slas = [0, 1, 999, ...SLAS.map((s) => s.id)];
  const depts = [1, 2, 3, 104, 105, 9999];
  for (const slaId of slas)
    for (const deptId of depts)
      for (const day of BASE_DAYS.filter((_, k) => k % 3 === 0))
        for (const time of ["02:30:00", "08:00:00", "16:59:59", "23:59:59"])
          cases.push({ kind: "ticket", slaId, deptId, created: `${day} ${time}`, reopened: null });
  // riaperti: conta la data di riapertura
  for (const slaId of [1, 101, 104])
    for (const day of BASE_DAYS.filter((_, k) => k % 4 === 1))
      cases.push({ kind: "ticket", slaId, deptId: 1, created: "2025-12-01 10:00:00", reopened: `${day} 11:11:11` });
  return cases;
}

function runSlaPhp<T>(dbName: string, cases: (GraceCase | TicketCase)[]): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("php", [`${__dirname}/php/sla-runner.php`, OST_ROOT, dbName]);
    let out = "";
    let err = "";
    child.stdout.on("data", (b: Buffer) => (out += b.toString()));
    child.stderr.on("data", (b: Buffer) => (err += b.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`sla-runner.php uscito con ${code}: ${err}`));
      const line = out.trim().split("\n").pop() ?? "{}";
      resolve((JSON.parse(line) as { results: T[] }).results);
    });
    child.stdin.end(JSON.stringify({ cases }));
  });
}

function mismatches<C, R>(cases: C[], php: R[], ts: R[]): string[] {
  const out: string[] = [];
  cases.forEach((c, k) => {
    if (JSON.stringify(php[k]) !== JSON.stringify(ts[k])) out.push(`${JSON.stringify(c)} php=${JSON.stringify(php[k])} ts=${JSON.stringify(ts[k])}`);
  });
  return out;
}

// ---------------------------------------------------------------------------------------------

beforeAll(async () => {
  await prepareSnapshot();
  await resetWorkingDatabases();
  await Promise.all([seed(PHP_DB), seed(TS_DB)]);
  await detectDbTimezone(db());
}, 300_000);
afterAll(closeDb);

describe("scadenze SLA: PHP vs TypeScript", () => {
  it("SLA::addGracePeriod con schedule diversi, ore intere/frazionarie e date difficili", async () => {
    const cases = graceCases();
    const php = await runSlaPhp<GraceResult>(PHP_DB, cases);
    expect(php.length).toBe(cases.length);

    const core = await loadConfigNamespace("core");
    const fallbackTimezone = core.str("default_timezone") || "UTC";
    const schedules = new Map<string, ScheduleData | null>();
    const ts: GraceResult[] = [];
    for (const c of cases) {
      try {
        const sla = (await loadSla(c.slaId))!;
        const key = `${c.scheduleId}:${sla.scheduleId}`;
        if (!schedules.has(key))
          schedules.set(
            key,
            await resolveSlaSchedule({ requested: c.scheduleId, sla: sla.scheduleId, default: core.int("schedule_id") }, { fallbackTimezone }),
          );
        const dt = addGracePeriod(PhpDateTime.create(c.start, c.tz), c.grace, schedules.get(key)!);
        ts.push({ date: dt.format("Y-m-d H:i:s"), zone: dt.timezone, ts: dt.getTimestamp() });
      } catch (e) {
        ts.push({ error: String(e) });
      }
    }
    const diff = mismatches(cases, php, ts);
    console.log(`addGracePeriod: ${cases.length} casi, ${cases.length - diff.length} identici`);
    expect(diff.slice(0, 20)).toEqual([]);
    // nessun caso deve essere finito in errore sul lato PHP (casi validi)
    expect(php.filter((r) => "error" in r)).toEqual([]);
  });

  for (const dbZone of [null, "Europe/Rome", "America/New_York"]) {
    it(`Ticket::getSLADueDate(true): reparto → SLA → schedule predefinito (db_timezone=${dbZone ?? "rilevato"})`, async () => {
      if (dbZone) await Promise.all([setDbTimezone(PHP_DB, dbZone), setDbTimezone(TS_DB, dbZone)]);
      const cases = ticketCases();
      const php = await runSlaPhp<TicketResult>(PHP_DB, cases);
      expect(php.length).toBe(cases.length);
      const ts: TicketResult[] = [];
      for (const c of cases) {
        try {
          ts.push({ due: await slaDueDate({ slaId: c.slaId, deptId: c.deptId, start: c.reopened || c.created }) });
        } catch (e) {
          ts.push({ error: String(e) });
        }
      }
      const diff = mismatches(cases, php, ts);
      console.log(`getSLADueDate (db_timezone=${dbZone ?? "rilevato"}): ${cases.length} casi, ${cases.length - diff.length} identici`);
      expect(diff.slice(0, 20)).toEqual([]);
      expect(php.filter((r) => "error" in r)).toEqual([]);
      // il test copre sia scadenze calcolate sia SLA nulli/inattivi
      expect(php.some((r) => "due" in r && r.due === null)).toBe(true);
    });
  }
});

// il DB TS deve essere quello di lavoro (vitest.diff.config.mts imposta OST_DB_NAME)
it("usa il DB di lavoro TypeScript", () => {
  expect(installConfig().dbName).toBe(TS_DB);
});
