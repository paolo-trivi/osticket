import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { comparePassword } from "@/server/auth/passwd";
import { closeDb, db } from "@/server/db";
import { massUserAction, registerAccount, sendUserConfirmEmail, sendUserResetEmail, updateAccount } from "@/server/domain/directory/accounts";
import { addOrgUser, createOrg, deleteOrg, removeOrgUsers, updateOrg, updateOrgProfile } from "@/server/domain/directory/orgs";
import { createUser, deleteUser, setUserOrganization, updateUser } from "@/server/domain/directory/users";
import { importUsers } from "@/server/domain/directory/users-import";
import { loadAgent } from "@/server/domain/staff/staff";
import { deleteTicketViaDeletedStatus } from "@/server/domain/ticket/delete";
import type { WriteContext } from "@/server/domain/ticket/context";
import { runWrite } from "@/server/domain/write";

import { compareWorkingDatabases, execBoth, PHP_DB, prepareSnapshot, resetWorkingDatabases, runPhp, TS_DB } from "./lib/harness";
import { mailsOf } from "./lib/mailpit";

const IP = "127.0.0.1";

beforeAll(prepareSnapshot);
beforeEach(async () => {
  await resetWorkingDatabases();
  // Senza DNS nell'ambiente di test: verifica dei domini email disattivata su entrambi i lati
  await execBoth("INSERT INTO {p}config (namespace, `key`, value, updated) VALUES ('core', 'verify_email_addrs', '0', NOW())");
});
afterAll(closeDb);

async function asAgent<T>(staffId: number, fn: (ctx: WriteContext) => Promise<T>): Promise<T> {
  const agent = await loadAgent(staffId, db());
  if (!agent) throw new Error("agente mancante");
  return runWrite({ agent, ip: IP }, fn);
}

/** Token casuali (config pwreset) resi confrontabili. */
async function normalizeTokens() {
  await execBoth("UPDATE {p}config SET `key` = CONCAT('TOKEN-', value) WHERE namespace = 'pwreset'");
}

const tokenRe = /token=[A-Za-z0-9_=]{48}/g;
const byKey = <T extends { to: string[]; subject: string }>(list: T[]) => [...list].sort((a, b) => `${a.to}|${a.subject}`.localeCompare(`${b.to}|${b.subject}`));
const clean = <T extends { html: string; to: string[]; subject: string }>(list: T[]) => byKey(list.map((m) => ({ ...m, html: m.html.replace(tokenRe, "token=<T>") })));

async function passwdOf(dbName: string, userId: number): Promise<string> {
  const { sql } = await import("kysely");
  const { rows } = await sql<{ passwd: string }>`SELECT passwd FROM ${sql.raw(`\`${dbName}\`.ost_user_account`)} WHERE user_id = ${userId}`.execute(db());
  return rows[0]?.passwd ?? "";
}

const NEW_USER = { name: "Bianchi, Mario", email: "mario.bianchi@ospedale.example", phone: "0874 123456", notes: "<p>nota <b>x</b></p>" };

describe("utenti: PHP vs TypeScript", () => {
  it("creazione (nome riordinato, telefono, note) e rifiuto dell'email già usata", async () => {
    const php = await runPhp<{ ok: boolean; id: number }>({ op: "user.create", args: { agent: 1, fields: NEW_USER } });
    const ts = await asAgent(1, (ctx) => createUser(ctx, NEW_USER));
    expect(php.ok).toBe(true);
    expect(ts).toEqual({ ok: true, id: php.id });
    const dup = { name: "X", email: "f.romano@ospedale.example" };
    expect((await runPhp<{ ok: boolean }>({ op: "user.create", args: { agent: 1, fields: dup } })).ok).toBe(false);
    expect(await asAgent(1, (ctx) => createUser(ctx, dup))).toMatchObject({ ok: false, error: "invalid", fields: { email: "in_use" } });
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("modifica (nome, email, note), modifica senza cambiamenti, cambio organizzazione", async () => {
    const a = { name: "Romano, Francesca", email: "fra.romano@ospedale.example", phone: "0874-479717", notes: "<p>vip</p>" };
    const b = { name: "Luca Ferrari", email: "l.ferrari@ospedale.example", phone: "0874412492", notes: "" };
    const c = { name: "Chiara  Bruno", email: "c.bruno@ospedale.example", phone: "0874443743", notes: "" };
    await runPhp({ op: "user.update", args: { agent: 2, user: 2, fields: a } });
    await runPhp({ op: "user.update", args: { agent: 2, user: 3, fields: b } });
    await runPhp({ op: "user.update", args: { agent: 2, user: 8, fields: c } });
    await runPhp({ op: "user.setorg", args: { agent: 2, user: 3, orgId: 5 } });
    expect(await asAgent(2, (ctx) => updateUser(ctx, 2, a))).toEqual({ ok: true });
    expect(await asAgent(2, (ctx) => updateUser(ctx, 3, b))).toEqual({ ok: true });
    expect(await asAgent(2, (ctx) => updateUser(ctx, 8, c))).toEqual({ ok: true });
    expect(await asAgent(2, (ctx) => setUserOrganization(ctx, 3, 5))).toEqual({ ok: true });
    expect(await asAgent(3, (ctx) => updateUser(ctx, 2, a))).toEqual({ ok: false, error: "forbidden" });
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("eliminazione: rifiutata con ticket, riuscita senza (account, email, form, indice)", async () => {
    await runPhp({ op: "user.create", args: { agent: 1, fields: NEW_USER } });
    await asAgent(1, (ctx) => createUser(ctx, NEW_USER));
    await execBoth("INSERT INTO {p}user_account (user_id, status, registered) VALUES (14, 1, NOW())");
    expect((await runPhp<{ ok: boolean; error?: string }>({ op: "user.delete", args: { agent: 1, user: 2 } })).error).toBe("tickets");
    expect(await asAgent(1, (ctx) => deleteUser(ctx, 2))).toEqual({ ok: false, error: "has_tickets" });
    expect((await runPhp<{ ok: boolean }>({ op: "user.delete", args: { agent: 1, user: 14 } })).ok).toBe(true);
    expect(await asAgent(1, (ctx) => deleteUser(ctx, 14))).toEqual({ ok: true });
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("eliminazione di un utente con i suoi ticket (deletetickets → User::deleteAllTickets)", async () => {
    const php = await runPhp<{ ok: boolean; error?: string }>({ op: "user.delete", args: { agent: 1, user: 2, deletetickets: 1 } });
    const ts = await asAgent(1, (ctx) => deleteUser(ctx, 2, { deleteTickets: true, hardDeleteTicket: deleteTicketViaDeletedStatus }));
    expect(php.ok).toBe(true);
    expect(ts).toEqual({ ok: true });
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("eliminazione con ticket rifiutata senza il permesso ticket.delete", async () => {
    const php = await runPhp<{ ok: boolean; error?: string }>({ op: "user.delete", args: { agent: 5, user: 2, deletetickets: 1 } });
    const ts = await asAgent(5, (ctx) => deleteUser(ctx, 2, { deleteTickets: true, hardDeleteTicket: deleteTicketViaDeletedStatus, checkPerm: false }));
    expect({ php: php.ok, ts: ts.ok }).toEqual({ php: false, ts: false });
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("import CSV: nuovo utente nell'organizzazione e aggiornamento di uno esistente", async () => {
    const pasted = "Nuovo Utente, nuovo@ospedale.example\nFrancesca R, f.romano@ospedale.example";
    const php = await runPhp<{ status: number }>({ op: "user.import", args: { agent: 1, pasted, orgId: 3 } });
    const ts = await asAgent(1, (ctx) => importUsers(ctx, pasted, { orgId: 3 }));
    expect(ts).toEqual({ ok: true, count: php.status });
    const bad = "Senza Email, non-una-email";
    expect(typeof (await runPhp<{ status: unknown }>({ op: "user.import", args: { agent: 1, pasted: bad } })).status).toBe("string");
    expect(await asAgent(1, (ctx) => importUsers(ctx, bad))).toMatchObject({ ok: false, error: "import" });
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("import CSV: righe lette come fgetcsv (virgolette nei campi, riga vuota, \\r isolato)", async () => {
    // virgolette letterali in un campo senza virgolette, spazi davanti alle virgolette; la riga vuota
    // ripropone il record precedente (CsvImportIterator): il PHP conta 3 utenti importati
    const pasted = 'Anna "Nina" Bianchi, anna.bianchi@ospedale.example\n\n  "Rossi, Luca", luca.rossi@ospedale.example';
    const php = await runPhp<{ status: number }>({ op: "user.import", args: { agent: 1, pasted } });
    const ts = await asAgent(1, (ctx) => importUsers(ctx, pasted));
    expect(ts).toEqual({ ok: true, count: php.status });
    // "\r" isolato: non chiude la riga (tre campi → "Bad data"), nessuna scrittura
    const cr = "Uno Due, uno.due@ospedale.example\rTre Quattro, tre.quattro@ospedale.example";
    expect(typeof (await runPhp<{ status: unknown }>({ op: "user.import", args: { agent: 1, pasted: cr } })).status).toBe("string");
    expect(await asAgent(1, (ctx) => importUsers(ctx, cr))).toMatchObject({ ok: false, error: "import" });
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("account: registrazione con password, aggiornamento con blocco, blocco/sblocco di massa", async () => {
    const reg = { username: "fromano", timezone: "Europe/Rome", passwd1: "segreto1", passwd2: "segreto1", "pwreset-flag": 1 };
    await runPhp({ op: "user.register", args: { agent: 1, user: 2, vars: reg } });
    await runPhp({ op: "user.account.update", args: { agent: 1, user: 2, vars: { username: "fromano2", timezone: "Europe/Rome", "locked-flag": 1 } } });
    await runPhp({ op: "user.account.update", args: { agent: 1, user: 2, vars: { username: "fromano2", timezone: "Europe/Rome", "locked-flag": 1 } } });
    await runPhp({ op: "user.mass", args: { agent: 1, action: "unlock", ids: [2, 3] } });
    await runPhp({ op: "user.mass", args: { agent: 1, action: "lock", ids: [2] } });
    await asAgent(1, (ctx) => registerAccount(ctx, 2, { username: "fromano", timezone: "Europe/Rome", passwd1: "segreto1", passwd2: "segreto1", "pwreset-flag": true }));
    await asAgent(1, (ctx) => updateAccount(ctx, 2, { username: "fromano2", timezone: "Europe/Rome", "locked-flag": true }));
    await asAgent(1, (ctx) => updateAccount(ctx, 2, { username: "fromano2", timezone: "Europe/Rome", "locked-flag": true }));
    expect(await asAgent(1, (ctx) => massUserAction(ctx, [2, 3], { action: "unlock" }))).toEqual({ ok: true, count: 1 });
    await asAgent(1, (ctx) => massUserAction(ctx, [2], { action: "lock" }));
    expect(await asAgent(2, (ctx) => massUserAction(ctx, [2], { action: "lock" }))).toMatchObject({ ok: false, error: "forbidden" });
    expect(await compareWorkingDatabases({ ignore: ["user_account.passwd"] })).toEqual([]);
    expect(comparePassword("segreto1", await passwdOf(PHP_DB, 2))).toBe(true);
    expect(comparePassword("segreto1", await passwdOf(TS_DB, 2))).toBe(true);
    // password troppo corta e non coincidente
    expect(await asAgent(1, (ctx) => registerAccount(ctx, 3, { passwd1: "abc", passwd2: "abc" }))).toMatchObject({ ok: false, fields: { passwd1: "too_short" } });
    expect(await asAgent(1, (ctx) => registerAccount(ctx, 3, { passwd1: "abcdefg", passwd2: "abcdefx" }))).toMatchObject({ ok: false, fields: { passwd2: "mismatch" } });
  });

  it("email di attivazione e di reset (pagine di contenuto, token in config)", async () => {
    await execBoth("INSERT INTO {p}user_account (user_id, status, registered) VALUES (2, 1, NOW())");
    const phpMails = await mailsOf(async () => {
      await runPhp({ op: "user.register", args: { agent: 1, user: 3, vars: { sendemail: 1, timezone: "" } } });
      await runPhp({ op: "user.mass", args: { agent: 1, action: "register", ids: [4, 5] } });
      await runPhp({ op: "user.sendmail", args: { agent: 1, user: 2, kind: "reset" } });
    }, 4);
    const tsMails = await mailsOf(async () => {
      await asAgent(1, (ctx) => registerAccount(ctx, 3, { sendemail: true, timezone: "" }));
      await asAgent(1, (ctx) => massUserAction(ctx, [4, 5], { action: "register" }));
      await asAgent(1, (ctx) => sendUserResetEmail(ctx, 2));
    }, 4);
    expect(phpMails.length).toBe(4);
    expect(clean(tsMails)).toEqual(clean(phpMails));
    expect(await asAgent(1, (ctx) => sendUserConfirmEmail(ctx, 2))).toEqual({ ok: false, error: "already_confirmed" });
    await normalizeTokens();
    expect(await compareWorkingDatabases()).toEqual([]);
  });
});

/** Campi aggiuntivi nel form utente (data, lista, numero, scelta, casella) con colonne cdata */
const USER_EXTRA_FIELDS = [
  "INSERT INTO {p}list (id, name, name_plural, sort_mode, masks, type, configuration, notes, created, updated) VALUES (2, 'Reparti', 'Reparti', 'Alpha', 0, NULL, '', '', NOW(), NOW())",
  "INSERT INTO {p}list_items (id, list_id, status, value, extra, sort, properties) VALUES (20, 2, 1, 'Radiologia', NULL, 1, '[]'), (21, 2, 1, 'Cardiologia', NULL, 2, '[]')",
  `INSERT INTO {p}form_field (id, form_id, flags, type, label, name, configuration, sort, hint, created, updated) VALUES
    (60, 1, 13057, 'datetime', 'Data di nascita', 'nascita', '{"time":false}', 5, '', NOW(), NOW()),
    (61, 1, 13057, 'list-2', 'Reparto', 'reparto', '{"multiselect":false}', 6, '', NOW(), NOW()),
    (62, 1, 13057, 'text', 'Codice', 'codice', '{"validator":"number"}', 7, '', NOW(), NOW()),
    (63, 1, 13057, 'choices', 'Turno', 'turno', '{"choices":"m:Mattina\\nn:Notte","multiselect":false}', 8, '', NOW(), NOW()),
    (64, 1, 13057, 'bool', 'Consenso', 'consenso', '{}', 9, '', NOW(), NOW())`,
  "ALTER TABLE {p}user__cdata ADD COLUMN nascita mediumtext, ADD COLUMN reparto mediumtext, ADD COLUMN turno mediumtext",
];

describe("form utente: stesso motore dei ticket (lettura dell'input e validazione)", () => {
  it("creazione e modifica con data (fuso dell'agente), lista, scelta e casella", async () => {
    await execBoth(...USER_EXTRA_FIELDS);
    const created = { ...NEW_USER, nascita: "2026-09-30", reparto: "21", codice: "12", turno: "m", consenso: "1" };
    const php = await runPhp<{ ok: boolean; id: number }>({ op: "user.create", args: { agent: 1, fields: created } });
    expect(php.ok).toBe(true);
    expect(await asAgent(1, (ctx) => createUser(ctx, created))).toEqual({ ok: true, id: php.id });
    const edited = { ...NEW_USER, nascita: "2026-10-01 10:30", reparto: "Radiologia", codice: "", turno: "n", consenso: "" };
    await runPhp({ op: "user.update", args: { agent: 1, user: php.id, fields: edited } });
    expect(await asAgent(1, (ctx) => updateUser(ctx, php.id, edited))).toEqual({ ok: true });
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("validatori dei campi come nel PHP: formula nel nome, numero non valido", async () => {
    await execBoth(...USER_EXTRA_FIELDS);
    for (const [fields, error] of [
      [{ ...NEW_USER, name: "=Rossi" }, { name: "formula" }],
      [{ ...NEW_USER, codice: "abc" }, { codice: "number" }],
    ] as const) {
      expect((await runPhp<{ ok: boolean }>({ op: "user.create", args: { agent: 1, fields } })).ok).toBe(false);
      expect(await asAgent(1, (ctx) => createUser(ctx, fields))).toMatchObject({ ok: false, error: "invalid", fields: error });
    }
    expect((await runPhp<{ ok: boolean }>({ op: "user.update", args: { agent: 1, user: 2, fields: { name: "-Romano", email: "f.romano@ospedale.example" } } })).ok).toBe(false);
    expect(await asAgent(1, (ctx) => updateUser(ctx, 2, { name: "-Romano", email: "f.romano@ospedale.example" }))).toMatchObject({ ok: false, fields: { name: "formula" } });
    expect(await compareWorkingDatabases()).toEqual([]);
  });
});

describe("organizzazioni: PHP vs TypeScript", () => {
  const ORG = { name: "Nuova Org <b>x</b>", address: "Via Roma 1", phone: "0874 111222", website: "http://x.it", notes: "<p>n</p>" };

  it("creazione e nome già esistente", async () => {
    const php = await runPhp<{ ok: boolean; id: number }>({ op: "org.create", args: { agent: 1, fields: ORG } });
    expect(await asAgent(1, (ctx) => createOrg(ctx, ORG))).toEqual({ ok: true, id: php.id });
    const dup = { name: "Cardiologia" };
    expect((await runPhp<{ ok: boolean }>({ op: "org.create", args: { agent: 1, fields: dup } })).ok).toBe(false);
    expect(await asAgent(1, (ctx) => createOrg(ctx, dup))).toMatchObject({ ok: false, fields: { name: "in_use" } });
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("modifica dei campi (nome e indirizzo) e del profilo (dominio, manager, flag, contatti)", async () => {
    await execBoth("UPDATE {p}user SET status = 1 WHERE id = 7");
    const fields = { name: "Radiologia 2", address: "Via X", phone: "", website: "", notes: "" };
    const profile = { domain: "cardio.example, ospedale2.example", manager: "s2", "collab-all-flag": 1, "assign-am-flag": 1, sharing: "sharing-all", contacts: ["3"] };
    const cardio = { name: "Cardiologia", address: "Viale 2", phone: "", website: "", notes: "" };
    await runPhp({ op: "org.update", args: { agent: 2, org: 2, vars: fields } });
    await runPhp({ op: "org.update", args: { agent: 2, org: 3, profile: true, vars: { ...cardio, ...profile } } });
    await runPhp({ op: "org.update", args: { agent: 2, org: 5, profile: true, vars: { name: "Amministrazione", domain: "", manager: "", sharing: "" } } });
    expect(await asAgent(2, (ctx) => updateOrg(ctx, 2, fields))).toEqual({ ok: true });
    expect(
      await asAgent(2, (ctx) =>
        updateOrgProfile(ctx, 3, cardio, { domain: profile.domain, manager: "s2", "collab-all-flag": true, "assign-am-flag": true, sharing: "sharing-all", contacts: ["3"] }),
      ),
    ).toEqual({ ok: true });
    expect(await asAgent(2, (ctx) => updateOrgProfile(ctx, 5, { name: "Amministrazione" }, { domain: "", manager: "", sharing: "" }))).toEqual({ ok: true });
    // dominio non valido: nessuna scrittura
    const bad = { name: "Cardiologia", domain: ".ospedale.example", manager: "", sharing: "" };
    expect((await runPhp<{ ok: boolean }>({ op: "org.update", args: { agent: 2, org: 6, profile: true, vars: bad } })).ok).toBe(false);
    expect(await asAgent(2, (ctx) => updateOrgProfile(ctx, 6, { name: "Cardiologia" }, { domain: bad.domain }))).toMatchObject({ ok: false, error: "invalid" });
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("eliminazione, rimozione e aggiunta di utenti", async () => {
    await runPhp({ op: "org.delete", args: { agent: 1, org: 4 } });
    await runPhp({ op: "org.removeusers", args: { agent: 1, org: 2, ids: [2, 7] } });
    await runPhp({ op: "org.adduser", args: { agent: 1, org: 6, userId: 3 } });
    await runPhp({ op: "org.adduser", args: { agent: 1, org: 6, fields: NEW_USER } });
    expect(await asAgent(1, (ctx) => deleteOrg(ctx, 4))).toEqual({ ok: true });
    expect(await asAgent(1, (ctx) => removeOrgUsers(ctx, 2, [2, 7]))).toEqual({ ok: true, count: 2 });
    expect(await asAgent(1, (ctx) => addOrgUser(ctx, 6, { userId: 3 }))).toEqual({ ok: true, id: 3 });
    expect(await asAgent(1, (ctx) => addOrgUser(ctx, 6, { fields: NEW_USER }))).toEqual({ ok: true, id: 14 });
    expect(await asAgent(1, (ctx) => addOrgUser(ctx, 6, { userId: 3 }))).toMatchObject({ ok: false });
    expect(await asAgent(3, (ctx) => deleteOrg(ctx, 5))).toEqual({ ok: false, error: "forbidden" });
    expect(await compareWorkingDatabases()).toEqual([]);
  });
});
