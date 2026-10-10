import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { hashPassword } from "@/server/auth/passwd";
import { closeDb, db } from "@/server/db";
import { loadClientIdentity } from "@/server/domain/client/identity";
import { registerClientAccount, updateClientProfile } from "@/server/domain/client/account";
import { performAccessLink, performTokenSignOn } from "@/server/domain/client/auth-access-link";
import { performConfirm } from "@/server/domain/client/auth-confirm";
import { performClientLogin } from "@/server/domain/client/auth-login";
import { performResetTokenLogin } from "@/server/domain/client/auth-reset";
import { requestClientPasswordReset } from "@/server/domain/client/password-reset";
import { installConfig } from "@/server/env";
import { ticketAuthToken } from "@/server/mail/message-id";

import { compareWorkingDatabases, execBoth, prepareSnapshot, resetWorkingDatabases, runPhp } from "./lib/harness";
import { mailsOf as rawMailsOf } from "./lib/mailpit";

/**
 * Portale clienti, autenticazione e account: login (strike/lockout), link di accesso, token ?auth=,
 * registrazione, conferma, reset password e profilo. PHP: test/diff/php/ops/portal.php.
 */
beforeAll(prepareSnapshot);
beforeEach(resetWorkingDatabases);
afterAll(closeDb);

/** Token casuali (config pwreset) nei link delle email: si confronta il resto */
async function mailsOf(run: () => Promise<unknown>, expected: number) {
  const mails = await rawMailsOf(run, expected);
  return mails.map((m) => ({ ...m, html: m.html.replace(/token=[A-Za-z0-9_=]{48}/g, "token=<TOKEN>") }));
}

let ipSeq = 0;
/** IP diverso per ogni scenario: il contatore dei tentativi TS è per IP, quello PHP per sessione */
const nextIp = () => `10.77.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;

const PASSWORD = "Segreta!2026";
const HASH = hashPassword(PASSWORD);

/** Account cliente per l'utente (stesso hash su entrambi i DB) */
function accountSql(userId: number, opts: { status?: number; passwd?: string | null; username?: string; extra?: string } = {}) {
  const passwd = opts.passwd === undefined ? `'${HASH}'` : opts.passwd === null ? "NULL" : `'${opts.passwd}'`;
  return `INSERT INTO {p}user_account (user_id, status, timezone, lang, username, passwd, backend, extra, registered)
    VALUES (${userId}, ${opts.status ?? 1}, 'Europe/Rome', NULL, ${opts.username ? `'${opts.username}'` : "NULL"}, ${passwd}, NULL, ${opts.extra ? `'${opts.extra}'` : "NULL"}, NOW())`;
}
const cfgSql = (key: string, value: string | number) =>
  `INSERT INTO {p}config (namespace, \`key\`, value, updated) VALUES ('core','${key}','${value}',NOW()) ON DUPLICATE KEY UPDATE value='${value}'`;
const tokenSql = (token: string, userId: number) =>
  `INSERT INTO {p}config (namespace, \`key\`, value, updated) VALUES ('pwreset','${token}','c${userId}',NOW())`;

interface PhpLogin {
  results: { ok: boolean; err: string | null }[];
  session: { id: number | null; key: string | null };
}

describe("login cliente (login.php → osTicketClientAuthentication)", () => {
  it("login riuscito: syslog User login, browser_lang, token di reset annullati", async () => {
    await execBoth(accountSql(3), cfgSql("log_level", 3), tokenSql("tokenvecchio0000000000000000000000000000000000000", 3));
    const ip = nextIp();
    const php = await runPhp<PhpLogin>({ op: "portal.login", args: { login: "l.ferrari@ospedale.example", password: PASSWORD }, ip });
    const ts = await performClientLogin({ login: "l.ferrari@ospedale.example", password: PASSWORD, ip });
    expect(php.results[0].ok).toBe(true);
    expect(php.session.id).toBe(3);
    expect(ts).toMatchObject({ ok: true, userId: 3, guest: null });
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("login con nome utente e password legacy MD5 (rehash bcrypt)", async () => {
    await execBoth(accountSql(4, { username: "scolombo", passwd: "5f4dcc3b5aa765d61d8327deb882cf99" }));
    const ip = nextIp();
    const php = await runPhp<PhpLogin>({ op: "portal.login", args: { login: "scolombo", password: "password" }, ip });
    const ts = await performClientLogin({ login: "scolombo", password: "password", ip });
    expect(php.results[0].ok).toBe(true);
    expect(ts.ok).toBe(true);
    // hash bcrypt con sale casuale: si confronta solo il formato
    expect(await compareWorkingDatabases({ ignore: ["user_account.passwd"] })).toEqual([]);
    const rows = await db().selectFrom("user_account").select("passwd").where("user_id", "=", 4).execute();
    expect(rows[0].passwd).toMatch(/^\$2a\$08\$/);
  });

  it("tre password errate: avviso 'Failed login attempt (user)' al terzo tentativo", async () => {
    await execBoth(accountSql(3));
    const ip = nextIp();
    const php = await runPhp<PhpLogin>({ op: "portal.login", args: { login: "l.ferrari@ospedale.example", password: "sbagliata", attempts: 3 }, ip });
    const ts = [];
    for (let i = 0; i < 3; i++) ts.push(await performClientLogin({ login: "l.ferrari@ospedale.example", password: "sbagliata", ip }));
    expect(php.results.map((r) => r.ok)).toEqual([false, false, false]);
    expect(ts.map((r) => r.ok)).toEqual([false, false, false]);
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("troppi tentativi: blocco, errore in syslog e avviso all'amministratore (email)", async () => {
    await execBoth(accountSql(3), cfgSql("client_max_logins", 2));
    const ip = nextIp();
    const args = { login: "l.ferrari@ospedale.example", password: "sbagliata", attempts: 4 };
    let php: PhpLogin | null = null;
    const phpMails = await mailsOf(async () => (php = await runPhp<PhpLogin>({ op: "portal.login", args, ip })), 2);
    const ts: unknown[] = [];
    const tsMails = await mailsOf(async () => {
      for (let i = 0; i < 4; i++) ts.push(await performClientLogin({ login: args.login, password: args.password, ip }));
    }, 2);
    expect(php!.results.every((r) => !r.ok)).toBe(true);
    expect(ts).toEqual([
      { ok: false, error: "invalid" },
      { ok: false, error: "invalid" },
      { ok: false, error: "invalid" },
      { ok: false, error: "locked_out" },
    ]);
    expect(await compareWorkingDatabases()).toEqual([]);
    expect(tsMails).toEqual(phpMails);
  });

  it("account non confermato o bloccato: accesso negato e tentativo contato", async () => {
    await execBoth(accountSql(3, { status: 0 }), accountSql(5, { status: 3 }));
    const ip = nextIp();
    const php1 = await runPhp<PhpLogin>({ op: "portal.login", args: { login: "l.ferrari@ospedale.example", password: PASSWORD, attempts: 2 }, ip });
    const php2 = await runPhp<PhpLogin>({ op: "portal.login", args: { login: "p.ricci@ospedale.example", password: PASSWORD, attempts: 3 }, ip });
    expect(php1.results[0]).toMatchObject({ ok: false, err: "Account confirmation required" });
    expect(php2.results[0]).toMatchObject({ ok: false, err: "Account is administratively locked" });
    const ts1 = [await performClientLogin({ login: "l.ferrari@ospedale.example", password: PASSWORD, ip }), await performClientLogin({ login: "l.ferrari@ospedale.example", password: PASSWORD, ip })];
    expect(ts1[0]).toEqual({ ok: false, error: "unconfirmed" });
    const ip2 = nextIp();
    for (let i = 0; i < 3; i++) expect(await performClientLogin({ login: "p.ricci@ospedale.example", password: PASSWORD, ip: ip2 })).toMatchObject({ ok: false });
    // il secondo PHP ha usato lo stesso IP ma una sessione nuova: stesse righe (avviso al 3° tentativo)
    expect(await compareWorkingDatabases({ ignore: ["syslog.ip_address", "syslog.log"] })).toEqual([]);
  });
});

describe("link di accesso (login.php lemail/lticket → AccessLinkAuthentication)", () => {
  it("con verifica email: invio del link (pagina access-link) al proprietario", async () => {
    const ip = nextIp();
    const args = { email: "l.ferrari@ospedale.example", number: "896022" };
    const phpMails = await mailsOf(() => runPhp({ op: "portal.accesslink", args, ip }), 1);
    let ts: unknown;
    const tsMails = await mailsOf(async () => (ts = await performAccessLink({ ...args, ip })), 1);
    expect(ts).toEqual({ ok: true, sent: true });
    expect(await compareWorkingDatabases()).toEqual([]);
    expect(tsMails).toEqual(phpMails);
    expect(tsMails[0].html).toContain("view.php?auth=o1x");
  });

  it("link al collaboratore del ticket", async () => {
    await execBoth(
      "INSERT INTO {p}thread_collaborator (flags, thread_id, user_id, role, created, updated) SELECT 3, id, 6, 'M', NOW(), NOW() FROM {p}thread WHERE object_type='T' AND object_id=9",
    );
    const ip = nextIp();
    const args = { email: "e.marino@ospedale.example", number: "896022" };
    const phpMails = await mailsOf(() => runPhp({ op: "portal.accesslink", args, ip }), 1);
    const tsMails = await mailsOf(() => performAccessLink({ ...args, ip }), 1);
    expect(await compareWorkingDatabases()).toEqual([]);
    expect(tsMails).toEqual(phpMails);
    // Collaborator::getVar('ticket_link'): token solo se il ticket non ha collaboratori
    expect(tsMails[0].html).toContain("tickets.php?id=9");
    expect(tsMails[0].cc).toEqual(["Elena Marino <e.marino@ospedale.example>"]);
  });

  it("senza verifica email: accesso diretto come ospite (syslog e browser_lang)", async () => {
    await execBoth(cfgSql("client_verify_email", 0), cfgSql("log_level", 3), accountSql(3));
    const ip = nextIp();
    const php = await runPhp<{ results: { login: boolean }[]; session: { id: number } }>({ op: "portal.accesslink", args: { email: "l.ferrari@ospedale.example", number: "896022" }, ip });
    const ts = await performAccessLink({ email: "l.ferrari@ospedale.example", number: "896022", ip });
    expect(php.results[0].login).toBe(true);
    expect(php.session.id).toBe(3);
    expect(ts).toMatchObject({ ok: true, sent: false, userId: 3, guest: { ticketId: 9, collabId: 0 } });
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("numero o email errati: tentativi contati (avviso al terzo)", async () => {
    const ip = nextIp();
    const php = await runPhp<{ results: { ok: boolean }[] }>({ op: "portal.accesslink", args: { email: "l.ferrari@ospedale.example", number: "390395", attempts: 3 }, ip });
    expect(php.results.map((r) => r.ok)).toEqual([false, false, false]);
    for (let i = 0; i < 3; i++) expect(await performAccessLink({ email: "l.ferrari@ospedale.example", number: "390395", ip })).toEqual({ ok: false, error: "invalid" });
    expect(await compareWorkingDatabases()).toEqual([]);
  });
});

describe("token ?auth= (view.php → AuthTokenAuthentication)", () => {
  async function token(ticketId: number, contactId: number, isOwner: boolean) {
    const t = await db().selectFrom("ticket").select("created").where("ticket_id", "=", ticketId).executeTakeFirstOrThrow();
    return ticketAuthToken({ isOwner, contactId, ticketId, createDate: t.created, secretSalt: installConfig().secretSalt });
  }

  it("token del proprietario: accesso come ospite al ticket", async () => {
    await execBoth(cfgSql("log_level", 3));
    const auth = await token(9, 3, true);
    const ip = nextIp();
    const php = await runPhp<{ ok: boolean; userId: number; ticketId: number }>({ op: "portal.token", args: { auth }, ip });
    const ts = await performTokenSignOn({ auth, ip });
    expect(php).toMatchObject({ ok: true, userId: 3, ticketId: 9 });
    expect(ts).toMatchObject({ ok: true, userId: 3, guest: { ticketId: 9, collabId: 0 } });
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("token del collaboratore e token manomesso", async () => {
    await execBoth(
      cfgSql("log_level", 3),
      "INSERT INTO {p}thread_collaborator (id, flags, thread_id, user_id, role, created, updated) SELECT 900, 3, id, 6, 'M', NOW(), NOW() FROM {p}thread WHERE object_type='T' AND object_id=9",
      accountSql(6),
    );
    const auth = await token(9, 900, false);
    const ip = nextIp();
    const php = await runPhp<{ ok: boolean; userId: number; ticketId: number }>({ op: "portal.token", args: { auth }, ip });
    const ts = await performTokenSignOn({ auth, ip });
    expect(php).toMatchObject({ ok: true, userId: 6, ticketId: 9 });
    expect(ts).toMatchObject({ ok: true, userId: 6, guest: { ticketId: 9, collabId: 900 } });
    const bad = `${auth.slice(0, -2)}xx`;
    const phpBad = await runPhp<{ ok: boolean }>({ op: "portal.token", args: { auth: bad }, ip });
    expect(phpBad.ok).toBe(false);
    expect(await performTokenSignOn({ auth: bad, ip })).toBeNull();
    expect(await compareWorkingDatabases()).toEqual([]);
  });
});

describe("registrazione, conferma e reset password (account.php, pwreset.php)", () => {
  // Il dominio di prova non ha record DNS: verifica degli indirizzi disattivata (verify_email_addrs)
  beforeEach(() => execBoth(cfgSql("verify_email_addrs", 0)));
  const REG = {
    do: "create",
    email: "nuovo.utente@ospedale.example",
    name: "Giulia Neri",
    phone: "0612345678",
    timezone: "Europe/Rome",
    passwd1: "Benvenuta#1",
    passwd2: "Benvenuta#1",
  };

  it("nuovo account: utente, form, indice, account e email di conferma con token", async () => {
    const phpMails = await mailsOf(() => runPhp({ op: "portal.register", args: { vars: REG } }), 1);
    let ts: unknown;
    const tsMails = await mailsOf(async () => (ts = await registerClientAccount(REG)), 1);
    expect(ts).toMatchObject({ ok: true, userId: 14 });
    expect(await compareWorkingDatabases({ ignore: ["user_account.passwd", "config.key"] })).toEqual([]);
    expect(tsMails).toEqual(phpMails);
  });

  it("utente esistente senza account (dati invariati) e password non valida", async () => {
    const vars = { ...REG, email: "l.ferrari@ospedale.example", name: "Luca Ferrari", phone: "" };
    const phpMails = await mailsOf(() => runPhp({ op: "portal.register", args: { vars } }), 1);
    const tsMails = await mailsOf(() => registerClientAccount(vars), 1);
    expect(await compareWorkingDatabases({ ignore: ["user_account.passwd", "config.key"] })).toEqual([]);
    expect(tsMails).toEqual(phpMails);

    const short = { ...REG, email: "altro@ospedale.example", passwd1: "corta", passwd2: "corta" };
    const php = await runPhp<{ ok: boolean; errors: Record<string, string> }>({ op: "portal.register", args: { vars: short } });
    const res = await registerClientAccount(short);
    expect(php.ok).toBe(false);
    expect(res).toMatchObject({ ok: false, fields: { passwd1: "too_short" } });
    expect(await compareWorkingDatabases({ ignore: ["user_account.passwd", "config.key"] })).toEqual([]);
  });

  it("conferma dal link: account confermato, accesso e token annullati", async () => {
    await execBoth(accountSql(3, { status: 0 }), tokenSql("conferma000000000000000000000000000000000000000000", 3), cfgSql("log_level", 3));
    const ip = nextIp();
    const php = await runPhp<{ confirmed: boolean; login: boolean }>({ op: "portal.confirm", args: { token: "conferma000000000000000000000000000000000000000000" }, ip });
    const ts = await performConfirm({ token: "conferma000000000000000000000000000000000000000000", ip });
    expect(php).toMatchObject({ confirmed: true, login: true });
    expect(ts).toMatchObject({ ok: true, confirmed: true, forceReset: false, userId: 3 });
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("conferma di un account senza password: cambio password obbligatorio", async () => {
    await execBoth(accountSql(5, { status: 0, passwd: null }), tokenSql("conferma111111111111111111111111111111111111111111", 5));
    const ip = nextIp();
    const php = await runPhp<{ confirmed: boolean; login: boolean }>({ op: "portal.confirm", args: { token: "conferma111111111111111111111111111111111111111111" }, ip });
    const ts = await performConfirm({ token: "conferma111111111111111111111111111111111111111111", ip });
    expect(php).toMatchObject({ confirmed: true, login: true });
    expect(ts).toMatchObject({ ok: true, confirmed: true, forceReset: true });
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("richiesta di reset: token in config e email pwreset-client; utente sconosciuto senza scritture", async () => {
    await execBoth(accountSql(3));
    const phpMails = await mailsOf(() => runPhp({ op: "portal.pwreset.send", args: { userid: "l.ferrari@ospedale.example" } }), 1);
    const tsMails = await mailsOf(() => requestClientPasswordReset("l.ferrari@ospedale.example", { pad: false }), 1);
    expect(await compareWorkingDatabases({ ignore: ["config.key"] })).toEqual([]);
    expect(tsMails).toEqual(phpMails);
    await runPhp({ op: "portal.pwreset.send", args: { userid: "nessuno@ospedale.example" } });
    expect(await requestClientPasswordReset("nessuno@ospedale.example", { pad: false })).toEqual({ ok: true });
    expect(await compareWorkingDatabases({ ignore: ["config.key"] })).toEqual([]);
  });

  it("accesso con il token di reset: cambio password obbligatorio; token errato = strike", async () => {
    await execBoth(accountSql(3), tokenSql("resetabc0000000000000000000000000000000000000000", 3), cfgSql("log_level", 3));
    const ip = nextIp();
    const php = await runPhp<{ ok: boolean; resetToken: string }>({ op: "portal.pwreset.login", args: { userid: "l.ferrari@ospedale.example", token: "resetabc0000000000000000000000000000000000000000" }, ip });
    const ts = await performResetTokenLogin({ userid: "l.ferrari@ospedale.example", token: "resetabc0000000000000000000000000000000000000000", ip });
    expect(php).toMatchObject({ ok: true, resetToken: "resetabc0000000000000000000000000000000000000000" });
    expect(ts).toMatchObject({ ok: true, userId: 3, resetToken: "resetabc0000000000000000000000000000000000000000" });
    expect(await compareWorkingDatabases()).toEqual([]);

    const ip2 = nextIp();
    const bad = await runPhp<{ ok: boolean; err: string }>({ op: "portal.pwreset.login", args: { userid: "l.ferrari@ospedale.example", token: "sbagliato" }, ip: ip2 });
    expect(bad).toMatchObject({ ok: false, err: "Unknown user" });
    expect(await performResetTokenLogin({ userid: "l.ferrari@ospedale.example", token: "sbagliato", ip: ip2 })).toEqual({ ok: false, error: "invalid_token" });
    expect(await compareWorkingDatabases()).toEqual([]);
  });
});

describe("profilo (profile.php → ClientAccount::update + User::updateInfo)", () => {
  beforeEach(() => execBoth(cfgSql("verify_email_addrs", 0)));
  it("nome, telefono e fuso orario", async () => {
    await execBoth(accountSql(3));
    const vars = { email: "l.ferrari@ospedale.example", name: "Luca A. Ferrari", phone: "3331234567", timezone: "Europe/London" };
    const php = await runPhp<{ ok: boolean }>({ op: "portal.profile", args: { client: 3, vars } });
    const ts = await updateClientProfile((await loadClientIdentity(3))!, vars);
    expect(php.ok).toBe(true);
    expect(ts).toMatchObject({ ok: true, passwordChanged: false });
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("campi aggiunti al form utente: risposte mancanti create, data nel fuso del cliente", async () => {
    await execBoth(
      accountSql(3),
      `INSERT INTO {p}form_field (id, form_id, flags, type, label, name, configuration, sort, hint, created, updated) VALUES
        (60, 1, 13057, 'datetime', 'Data di nascita', 'nascita', '{"time":true}', 5, '', NOW(), NOW()),
        (61, 1, 13057, 'text', 'Reparto', 'reparto', '{}', 6, '', NOW(), NOW())`,
      "ALTER TABLE {p}user__cdata ADD COLUMN nascita mediumtext, ADD COLUMN reparto mediumtext",
    );
    const vars = { email: "l.ferrari@ospedale.example", name: "Luca Ferrari", phone: "3331234567", timezone: "Europe/London", nascita: "2026-09-30 08:00" };
    const php = await runPhp<{ ok: boolean }>({ op: "portal.profile", args: { client: 3, vars } });
    const ts = await updateClientProfile((await loadClientIdentity(3))!, vars);
    expect(php.ok).toBe(true);
    expect(ts).toMatchObject({ ok: true });
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("cambio password con la password attuale; password attuale errata rifiutata", async () => {
    await execBoth(accountSql(3), tokenSql("resetabc0000000000000000000000000000000000000000", 3));
    const wrong = { email: "l.ferrari@ospedale.example", name: "Luca Ferrari", timezone: "Europe/Rome", cpasswd: "no", passwd1: "NuovaPass#9", passwd2: "NuovaPass#9" };
    const phpWrong = await runPhp<{ ok: boolean; errors: Record<string, string> }>({ op: "portal.profile", args: { client: 3, vars: wrong } });
    const tsWrong = await updateClientProfile((await loadClientIdentity(3))!, wrong);
    expect(phpWrong.errors.cpasswd).toBe("Invalid current password!");
    expect(tsWrong).toMatchObject({ ok: false, fields: { cpasswd: "current_invalid" } });
    const vars = { ...wrong, cpasswd: PASSWORD };
    const php = await runPhp<{ ok: boolean }>({ op: "portal.profile", args: { client: 3, vars } });
    const ts = await updateClientProfile((await loadClientIdentity(3))!, vars);
    expect(php.ok).toBe(true);
    expect(ts).toMatchObject({ ok: true, passwordChanged: true });
    expect(await compareWorkingDatabases({ ignore: ["user_account.passwd"] })).toEqual([]);
  });

  it("nuova password dopo il reset (token in sessione, senza password attuale)", async () => {
    await execBoth(accountSql(3, { status: 5 }), tokenSql("resetabc0000000000000000000000000000000000000000", 3));
    const vars = { email: "l.ferrari@ospedale.example", name: "Luca Ferrari", timezone: "Europe/Rome", passwd1: "NuovaPass#9", passwd2: "NuovaPass#9" };
    const php = await runPhp<{ ok: boolean }>({ op: "portal.profile", args: { client: 3, vars, resetToken: "resetabc0000000000000000000000000000000000000000" } });
    const ts = await updateClientProfile((await loadClientIdentity(3))!, vars, "resetabc0000000000000000000000000000000000000000");
    expect(php.ok).toBe(true);
    expect(ts).toMatchObject({ ok: true, passwordChanged: true });
    expect(await compareWorkingDatabases({ ignore: ["user_account.passwd"] })).toEqual([]);
  });
});
