import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { comparePassword } from "@/server/auth/passwd";
import { closeDb, db, type Tx } from "@/server/db";
import type { PhpVars } from "@/server/php/values";
import { massStaff, saveStaff, setAgentPassword, type StaffMassAction } from "@/server/domain/admin/staff-admin";

import { compareWorkingDatabases, execBoth, PHP_DB, prepareSnapshot, resetWorkingDatabases, runPhp, TS_DB } from "./lib/harness";
import { mailsOf } from "./lib/mailpit";

/** Agenti (scp/staff.php → Staff::update/create/delete, mass_process; ajax.staff.php setPassword). */
const IP = "127.0.0.1";

beforeAll(prepareSnapshot);
beforeEach(async () => {
  await resetWorkingDatabases();
  // niente verifica DNS dei domini email di prova
  await execBoth("INSERT INTO {p}config (namespace, `key`, value, updated) VALUES ('core', 'verify_email_addrs', '0', NOW())");
});
afterAll(closeDb);

type R = { ok: boolean; id?: number | null; errors?: Record<string, string>; num?: number; error?: string };
const tx = <T>(fn: (t: Tx) => Promise<T>) => db().transaction().execute(fn);
const keys = (e?: Record<string, string>) => Object.keys(e ?? {}).sort();
/** i token di reset sono casuali: si uniformano prima del confronto */
const TOKENS = "UPDATE {p}config SET `key` = CONCAT('TOKEN-', value) WHERE namespace = 'pwreset'";
const tokenRe = /token=[A-Za-z0-9_=]{48}/g;
const norm = <T extends { html: string }>(l: T[]) => l.map((m) => ({ ...m, html: m.html.replace(tokenRe, "token=<T>") }));

async function staffPasswd(dbName: string, staffId: number): Promise<string> {
  const { rows } = await sql<{ passwd: string }>`SELECT passwd FROM ${sql.raw(`\`${dbName}\`.ost_staff`)} WHERE staff_id = ${staffId}`.execute(db());
  return rows[0]?.passwd ?? "";
}

const MROSSI: PhpVars = {
  do: "update",
  id: "2",
  username: "mrossi",
  firstname: "Mario",
  lastname: "Rossi",
  email: "mrossi@ospedale.example",
  phone: "",
  phone_ext: "",
  mobile: "",
  backend: "",
  dept_id: "1",
  role_id: "2",
  notes: "",
  perms: ["user.create", "user.edit", "user.dir", "org.create", "org.edit", "faq.manage"],
};

async function save(id: number | null, vars: PhpVars, passwd?: PhpVars) {
  const php = await runPhp<R>({ op: "admin.staff.save", args: { agent: 1, id, vars, passwd } });
  const all: PhpVars = { ...vars };
  // scp/staff.php do=create: password dal dialogo (sessione) oppure email di benvenuto
  if (!id) {
    if (passwd) {
      for (const [k, v] of Object.entries(passwd)) if (all[k] === undefined) all[k] = v;
    } else if (!all.backend || all.backend === "local") all.welcome_email = 1;
  }
  const res = await tx((t) => saveStaff(t, id, all, { actorId: 1, ip: IP }));
  await res.send?.();
  return { php, ts: res as R };
}

describe("agenti: PHP vs TypeScript", () => {
  it("modifica: dati, flag, permessi, reparto primario, accessi estesi, team, ruolo predefinito in assegnazione", async () => {
    const vars: PhpVars = {
      ...MROSSI,
      firstname: "Mario <b>",
      phone: "0874409470",
      phone_ext: "12",
      mobile: "333 1234567",
      dept_id: "2",
      role_id: "1",
      onvacation: "on",
      assigned_only: "on",
      isadmin: "1",
      notes: "<p>nota</p>",
      perms: ["user.dir", "visibility.agents", "stats.agents"],
      dept_access: ["1", "3"],
      dept_access_role: { "1": "2", "3": "3" },
      dept_access_alerts: { "1": "1" },
      teams: ["1"],
      team_alerts: { "1": "1" },
      assign_use_pri_role: "on",
    };
    const r = await save(2, vars);
    expect(r.php).toMatchObject({ ok: true, id: 2 });
    expect(r.ts).toMatchObject({ ok: true, id: 2 });
    // secondo salvataggio: accesso esteso rimosso, team rimosso, flag cambiati
    const v2 = { ...vars, dept_access: ["3"], teams: undefined, onvacation: undefined, assign_use_pri_role: undefined, isadmin: undefined, islocked: "1" };
    const r2 = await save(2, v2);
    expect(r2.ts.ok).toBe(r2.php.ok);
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("creazione con email di benvenuto (registration-staff) e con password impostata", async () => {
    const nv: PhpVars = { ...MROSSI, do: "create", id: "", username: "fneri", firstname: "Franca", lastname: "Neri", email: "fneri@ospedale.example", dept_id: "3", role_id: "3", teams: ["1"] };
    const phpMails = await mailsOf(() => runPhp<R>({ op: "admin.staff.save", args: { agent: 1, id: null, vars: nv } }), 1);
    const tsMails = await mailsOf(async () => {
      const res = await tx((t) => saveStaff(t, null, { ...nv, welcome_email: 1 }, { actorId: 1, ip: IP }));
      expect(res.ok).toBe(true);
      await res.send?.();
    }, 1);
    expect(phpMails.length).toBe(1);
    expect(norm(tsMails)).toEqual(norm(phpMails));
    await execBoth(TOKENS);
    const pv: PhpVars = { ...nv, username: "gblu", email: "gblu@ospedale.example", firstname: "Gino", lastname: "Blu" };
    const r = await save(null, pv, { welcome_email: "", passwd1: "Segreta123", passwd2: "Segreta123", change_passwd: "1" });
    expect(r.php.ok).toBe(true);
    expect(r.ts).toMatchObject({ ok: true, id: r.php.id });
    expect(await compareWorkingDatabases({ ignore: ["staff.passwd"] })).toEqual([]);
    expect(comparePassword("Segreta123", await staffPasswd(TS_DB, r.php.id!))).toBe(true);
    expect(comparePassword("Segreta123", await staffPasswd(PHP_DB, r.php.id!))).toBe(true);
  });

  it("errori: username/email non validi o in uso, email di sistema, telefono, reparto non attivo, ultimo amministratore", async () => {
    for (const bad of [
      { ...MROSSI, username: "1", email: "nonvalida", phone: "12ab", firstname: "" },
      { ...MROSSI, username: "lbianchi", email: "lbianchi@ospedale.example" },
      { ...MROSSI, email: "support@example.com", dept_id: "", role_id: "" },
    ]) {
      const r = await save(2, bad);
      expect(r.php.ok).toBe(false);
      expect(keys(r.ts.errors)).toEqual(keys(r.php.errors));
    }
    await execBoth("UPDATE {p}department SET flags = 0 WHERE id = 3");
    const inactive = await save(2, { ...MROSSI, dept_id: "3" });
    expect(keys(inactive.ts.errors)).toEqual(keys(inactive.php.errors));
    // l'unico amministratore attivo non può togliersi il ruolo
    const admin = await save(1, { ...MROSSI, id: "1", username: "devadmin", email: "admin@example.com", firstname: "Dev", lastname: "Admin" });
    expect(admin.php.ok).toBe(false);
    expect(keys(admin.ts.errors)).toEqual(keys(admin.php.errors));
    // ...ma se cambia anche l'email il controllo non scatta ($uid della nuova email): stranezza replicata
    const quirk = await save(1, { ...MROSSI, id: "1", username: "devadmin", email: "admin@ospedale.example", firstname: "Dev", lastname: "Admin", dept_id: "1" });
    expect(quirk.php.ok).toBe(true);
    expect(quirk.ts.ok).toBe(true);
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("password impostata dall'amministratore e email di reset (pwreset-staff, syslog)", async () => {
    const vars = { welcome_email: "", passwd1: "NuovaPass9", passwd2: "NuovaPass9", change_passwd: "1" };
    expect((await runPhp<R>({ op: "admin.staff.setpasswd", args: { agent: 1, id: 3, vars } })).ok).toBe(true);
    expect((await tx((t) => setAgentPassword(t, 3, { passwd1: "NuovaPass9", passwd2: "NuovaPass9", change_passwd: true }, IP))).ok).toBe(true);
    expect(await compareWorkingDatabases({ ignore: ["staff.passwd"] })).toEqual([]);
    expect(comparePassword("NuovaPass9", await staffPasswd(TS_DB, 3))).toBe(true);

    const phpMails = await mailsOf(() => runPhp<R>({ op: "admin.staff.setpasswd", args: { agent: 1, id: 4, vars: { welcome_email: "1" } } }), 1);
    const tsMails = await mailsOf(async () => {
      const r = await tx((t) => setAgentPassword(t, 4, { welcome_email: true }, IP));
      expect(r.ok).toBe(true);
      await r.send?.();
    }, 1);
    expect(norm(tsMails)).toEqual(norm(phpMails));
    await execBoth(TOKENS);
    expect(await compareWorkingDatabases({ ignore: ["staff.passwd"] })).toEqual([]);
    // password troppo corta o diversa dalla conferma
    expect((await tx((t) => setAgentPassword(t, 4, { passwd1: "abc", passwd2: "abc" }, IP))).errors).toEqual({ passwd1: "too_short" });
    expect((await tx((t) => setAgentPassword(t, 4, { passwd1: "abcdefgh", passwd2: "abcdefgx" }, IP))).errors).toEqual({ passwd1: "mismatch" });
  });

  it("azioni di massa: abilita/disabilita, permessi, cambio reparto con accesso al vecchio, eliminazione", async () => {
    const run = async (a: StaffMassAction, ids: number[], post: PhpVars = {}) => {
      const php = await runPhp<R>({ op: "admin.staff.mass", args: { agent: 1, a, ids: ids.map(String), post } });
      const ts = await tx((t) => massStaff(t, a, ids, 1, post));
      expect(ts.ok).toBe(php.ok);
      return { php, ts };
    };
    await run("disable", [4, 5]);
    await run("enable", [5]);
    expect((await run("disable", [1, 2])).ts.error).toBe("self");
    await run("permissions", [3, 5], { perms: ["user.dir", "org.edit", "emails.banlist"] });
    await run("permissions", [4], {});
    await run("department", [2, 4], { dept_id: "3", role_id: "2", eavesdrop: "1" });
    await run("department", [3], { dept_id: "2", role_id: "1" });
    await execBoth("UPDATE {p}ticket SET staff_id = 5 WHERE ticket_id IN (1, 2)", "INSERT INTO {p}team_member (team_id, staff_id, flags) VALUES (1, 5, 1)");
    await run("delete", [5]);
    expect(await compareWorkingDatabases()).toEqual([]);
  });
});
