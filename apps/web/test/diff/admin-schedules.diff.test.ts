import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { closeDb, db, type Tx } from "@/server/db";
import type { PhpVars } from "@/server/domain/admin/php";
import { addSchedule, deleteScheduleEntries, deleteSchedules, saveScheduleEntry, updateSchedule, type EntryInput } from "@/server/domain/admin/schedule";

import { compareWorkingDatabases, prepareSnapshot, resetWorkingDatabases, runPhp } from "./lib/harness";

/** Orari (scp/schedules.php, ajax.schedule.php → Schedule / ScheduleEntry). */
beforeAll(prepareSnapshot);
beforeEach(resetWorkingDatabases);
afterAll(closeDb);

type R = { ok: boolean; id?: number | null; errors?: Record<string, string>; formErrors?: Record<string, string>; num?: number; error?: string };
const tx = <T>(fn: (t: Tx) => Promise<T>) => db().transaction().execute(fn);

/** POST del form voce → input TS (checkbox allday). */
function entryInput(v: Record<string, string>): EntryInput {
  const { allday, ...rest } = v;
  return { ...rest, allday: !!allday && allday !== "0" };
}

async function entry(schedule: number, entryId: number | null, vars: Record<string, string>) {
  const php = await runPhp<R>({ op: "admin.schedule.entry", args: { agent: 1, schedule, entry: entryId, vars } });
  const ts = await tx((t) => saveScheduleEntry(t, schedule, entryId, entryInput(vars), { actorId: 1 }));
  return { php, ts };
}

describe("orari: PHP vs TypeScript", () => {
  it("nuovo orario, clonazione con le voci, nome già usato e tipo diverso", async () => {
    const vars: PhpVars = { name: "Reperibilità", type: "bizhrs", timezone: "Europe/Rome", description: "<p>Turni <script>x</script></p>" };
    const php = await runPhp<R>({ op: "admin.schedule.add", args: { agent: 1, vars } });
    const ts = await tx((t) => addSchedule(t, vars));
    expect(ts).toMatchObject({ ok: true, id: php.id });
    const cl: PhpVars = { name: "Copia 24/5", type: "bizhrs", timezone: "", description: "Copia" };
    const php2 = await runPhp<R>({ op: "admin.schedule.add", args: { agent: 1, clone: 3, vars: cl } });
    const ts2 = await tx((t) => addSchedule(t, cl, 3));
    expect(ts2).toMatchObject({ ok: true, id: php2.id });
    const dup = await runPhp<R>({ op: "admin.schedule.add", args: { agent: 1, vars: { ...cl, name: "24/7" } } });
    expect(dup.ok).toBe(false);
    expect((await tx((t) => addSchedule(t, { ...cl, name: "24/7" }))).ok).toBe(false);
    const wrong = await runPhp<R>({ op: "admin.schedule.add", args: { agent: 1, clone: 4, vars: { ...cl, name: "Altro" } } });
    expect(wrong.ok).toBe(false);
    expect((await tx((t) => addSchedule(t, { ...cl, name: "Altro" }, 4))).ok).toBe(false);
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("modifica: nome, fuso, descrizione, festività e ordinamento delle voci; poi fuso azzerato", async () => {
    const vars: PhpVars = { name: "Lun-Ven 8-17", type: "bizhrs", timezone: "Europe/Rome", description: "<p>Orario <b>ufficio</b></p>", holidays: ["4"], "sort-1": "2", "sort-2": "1" };
    expect((await runPhp<R>({ op: "admin.schedule.update", args: { agent: 1, id: 1, vars } })).ok).toBe(true);
    expect((await tx((t) => updateSchedule(t, 1, vars))).ok).toBe(true);
    const v2: PhpVars = { name: "Lun-Ven 8-17", type: "bizhrs", timezone: "", description: "", "sort-1": "2" };
    expect((await runPhp<R>({ op: "admin.schedule.update", args: { agent: 1, id: 1, vars: v2 } })).ok).toBe(true);
    expect((await tx((t) => updateSchedule(t, 1, v2))).ok).toBe(true);
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("voci: festività annuale (data), sabato lavorativo, mensile, una tantum, modifica e conflitti", async () => {
    const cases: [number, Record<string, string>][] = [
      [4, { name: "Festa patronale", starts_on: "2026-12-07", allday: "1", repeats: "yearly", yearly: "date" }],
      [4, { name: "Festa del lavoro", starts_on: "2027-05-01", allday: "1", repeats: "yearly", yearly: "1", yearly_day: "5", yearly_month: "5" }],
      [3, { name: "Sabato", starts_on: "2026-11-07", starts_at: "09:00", ends_at: "13:30", repeats: "weekly", weekly_day: "6" }],
      [1, { name: "Riunione mensile", starts_on: "2026-11-02", starts_at: "14:00", ends_at: "15:00", repeats: "monthly", monthly: "2", monthly_day: "3", stops_on: "2027-06-30" }],
      [1, { name: "Inventario", starts_on: "2026-12-28", allday: "1", repeats: "never" }],
    ];
    for (const [s, v] of cases) {
      const r = await entry(s, null, v);
      expect(r.php.ok).toBe(true);
      expect(r.ts).toMatchObject({ ok: true, id: r.php.id });
    }
    // modifica della voce "Monday" (orario e nome)
    const upd = await entry(1, 1, { name: "Lunedì", starts_on: "2019-01-07", starts_at: "07:30", ends_at: "16:00", repeats: "weekly", weekly_day: "1" });
    expect(upd.php.ok).toBe(true);
    expect(upd.ts.ok).toBe(true);
    // conflitti: giorno feriale già coperto da "weekdays", nome duplicato, voce giornaliera esistente, intervallo non valido
    for (const [s, v] of [
      [3, { name: "Martedì", starts_on: "2026-11-03", allday: "1", repeats: "weekly", weekly_day: "2" }],
      [1, { name: "Tuesday", starts_on: "2026-11-03", starts_at: "08:00", ends_at: "12:00", repeats: "never" }],
      [2, { name: "Altro", starts_on: "2026-11-03", allday: "1", repeats: "never" }],
      [1, { name: "Serale", starts_on: "2026-11-03", starts_at: "18:00", ends_at: "17:00", repeats: "never" }],
      [1, { name: "", starts_on: "", starts_at: "18:00", ends_at: "19:00", repeats: "monthly", monthly: "2" }],
    ] as [number, Record<string, string>][]) {
      const r = await entry(s, null, v);
      expect(r.php.ok).toBe(false);
      expect(r.ts.ok).toBe(false);
    }
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("eliminazione di voci e di orari", async () => {
    expect((await runPhp<R>({ op: "admin.schedule.entries.delete", args: { agent: 1, schedule: 4, ids: ["8", "9", "1"] } })).num).toBe(2);
    expect(await tx((t) => deleteScheduleEntries(t, 4, [8, 9, 1]))).toBe(2);
    const php = await runPhp<R>({ op: "admin.schedule.delete", args: { agent: 1, ids: ["3", "99"] } });
    const ts = await tx((t) => deleteSchedules(t, [3, 99]));
    expect(ts.num).toBe(php.num);
    expect(await compareWorkingDatabases()).toEqual([]);
  });
});
