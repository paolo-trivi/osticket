import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { newMfaKey, pendingOtpForTests, validateOtp } from "@/server/auth/mfa";
import { comparePassword } from "@/server/auth/passwd";
import { performStaffLogin } from "@/server/auth/staff-auth";
import { performResetTokenLogin } from "@/server/auth/staff-recovery";
import { coreConfig } from "@/server/config/config";
import { closeDb, db } from "@/server/db";
import { sendStaffResetEmail } from "@/server/domain/staff/password-reset";
import { changeStaffPassword, updateStaffProfile } from "@/server/domain/staff/profile";
import { setDefault2fa, setup2faEmail, verify2faSetup } from "@/server/domain/staff/two-factor";
import { loadAgent } from "@/server/domain/staff/staff";
import type { WriteContext } from "@/server/domain/ticket/context";
import { runWrite } from "@/server/domain/write";

import { compareWorkingDatabases, execBoth, PHP_DB, prepareSnapshot, resetWorkingDatabases, runPhp, TS_DB } from "./lib/harness";
import { mailsOf } from "./lib/mailpit";

const IP = "127.0.0.1";

beforeAll(prepareSnapshot);
beforeEach(async () => {
  await resetWorkingDatabases();
  await execBoth("INSERT INTO {p}config (namespace, `key`, value, updated) VALUES ('core', 'verify_email_addrs', '0', NOW())");
});
afterAll(closeDb);

async function asAgent<T>(staffId: number, fn: (ctx: WriteContext) => Promise<T>): Promise<T> {
  const agent = await loadAgent(staffId, db());
  if (!agent) throw new Error("agente mancante");
  return runWrite({ agent, ip: IP }, fn);
}

async function staffPasswd(dbName: string, staffId: number): Promise<string> {
  const { rows } = await sql<{ passwd: string }>`SELECT passwd FROM ${sql.raw(`\`${dbName}\`.ost_staff`)} WHERE staff_id = ${staffId}`.execute(db());
  return rows[0]?.passwd ?? "";
}

const tokenRe = /token=[A-Za-z0-9_=]{48}/g;
const sortMails = <T extends { to: string[]; subject: string; html: string }>(list: T[]) =>
  [...list]
    .map((m) => ({ ...m, html: m.html.replace(tokenRe, "token=<T>").replace(/\b[1-9]\d{5}\b/g, "<OTP>") }))
    .sort((a, b) => `${a.to}|${a.subject}`.localeCompare(`${b.to}|${b.subject}`));

const PROFILE = {
  firstname: "Mario <b>",
  lastname: "Rossi",
  email: "mrossi@ospedale.example",
  phone: "0874409470",
  phone_ext: "12",
  mobile: "",
  signature: "<p>Ciao<script>x</script></p>",
  timezone: "Europe/Rome",
  locale: "",
  max_page_size: "20",
  auto_refresh_rate: "5",
  default_signature_type: "mine",
  default_paper_size: "A4",
  lang: "it",
  datetime_format: "relative",
  default_from_name: "mine",
  default_2fa: "",
  thread_view_order: "desc",
  default_ticket_queue_id: "0",
  reply_redirect: "Queue",
  img_att_view: "inline",
  editor_spacing: "single",
};

describe("profilo agente: PHP vs TypeScript", () => {
  it("aggiornamento delle preferenze (staff + config staff.<id>) e secondo salvataggio senza modifiche", async () => {
    await runPhp({ op: "profile.update", args: { agent: 2, vars: { ...PROFILE, onvacation: "1" } } });
    await runPhp({ op: "profile.update", args: { agent: 2, vars: { ...PROFILE, onvacation: "1", editor_spacing: "double" } } });
    expect(await asAgent(2, (ctx) => updateStaffProfile(ctx, { ...PROFILE, onvacation: true }))).toEqual({ ok: true });
    expect(await asAgent(2, (ctx) => updateStaffProfile(ctx, { ...PROFILE, onvacation: true, editor_spacing: "double" }))).toEqual({ ok: true });
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("errori di validazione: nessuna scrittura", async () => {
    const bad = { ...PROFILE, email: "support@example.com", phone: "12ab" };
    expect((await runPhp<{ ok: boolean }>({ op: "profile.update", args: { agent: 2, vars: bad } })).ok).toBe(false);
    expect(await asAgent(2, (ctx) => updateStaffProfile(ctx, bad))).toMatchObject({ ok: false, fields: { email: "system_email", phone: "invalid" } });
    const taken = { ...PROFILE, email: "lbianchi@ospedale.example", default_signature_type: "mine", signature: "" };
    expect((await runPhp<{ ok: boolean }>({ op: "profile.update", args: { agent: 2, vars: taken } })).ok).toBe(false);
    expect(await asAgent(2, (ctx) => updateStaffProfile(ctx, taken))).toMatchObject({ ok: false, fields: { email: "in_use", default_signature_type: "no_signature" } });
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("cambio password: password attuale, politica, token di reset annullati", async () => {
    await execBoth("INSERT INTO {p}config (namespace, `key`, value, updated) VALUES ('pwreset', 'tok-mrossi', '2', NOW())");
    expect((await runPhp<{ ok: boolean }>({ op: "profile.password", args: { agent: 2, current: "Passw0rd!dev", passwd1: "NuovaPass1" } })).ok).toBe(true);
    expect(await asAgent(2, (ctx) => changeStaffPassword(ctx, { current: "Passw0rd!dev", passwd1: "NuovaPass1", passwd2: "NuovaPass1" }))).toMatchObject({ ok: true });
    expect(await compareWorkingDatabases({ ignore: ["staff.passwd"] })).toEqual([]);
    expect(comparePassword("NuovaPass1", await staffPasswd(PHP_DB, 2))).toBe(true);
    expect(comparePassword("NuovaPass1", await staffPasswd(TS_DB, 2))).toBe(true);
    // password attuale errata, troppo corta, uguale all'attuale (maiuscole ignorate)
    expect((await runPhp<{ error: string }>({ op: "profile.password", args: { agent: 3, current: "sbagliata", passwd1: "xxxxxxx" } })).error).toBe("current");
    expect(await asAgent(3, (ctx) => changeStaffPassword(ctx, { current: "sbagliata", passwd1: "xxxxxxx", passwd2: "xxxxxxx" }))).toMatchObject({ fields: { current: "incorrect" } });
    expect(await asAgent(3, (ctx) => changeStaffPassword(ctx, { current: "Passw0rd!dev", passwd1: "abc", passwd2: "abc" }))).toMatchObject({ fields: { passwd1: "too_short" } });
    expect(await asAgent(3, (ctx) => changeStaffPassword(ctx, { current: "Passw0rd!dev", passwd1: "PASSW0RD!DEV", passwd2: "PASSW0RD!DEV" }))).toMatchObject({ fields: { passwd1: "same_as_current" } });
    expect(await compareWorkingDatabases({ ignore: ["staff.passwd"] })).toEqual([]);
  });

  it("reset password via email (syslog, token, pagina pwreset-staff) e login con token + nuova password", async () => {
    const cfg = await coreConfig();
    const phpMails = await mailsOf(() => runPhp({ op: "staff.pwreset.send", args: { userid: "mrossi" } }), 1);
    const tsMails = await mailsOf(async () => {
      const r = await db().transaction().execute((tx) => sendStaffResetEmail(tx, cfg, "mrossi", IP));
      expect(r.sent).toBe(true);
      await r.send?.();
    }, 1);
    expect(phpMails.length).toBe(1);
    expect(sortMails(tsMails)).toEqual(sortMails(phpMails));
    await execBoth("UPDATE {p}config SET `key` = 'TOKEN-2' WHERE namespace = 'pwreset'");
    expect(await compareWorkingDatabases()).toEqual([]);

    // login con il token (PasswordResetTokenBackend) e cambio password senza password attuale
    const php = await runPhp<{ ok: boolean }>({ op: "staff.pwreset.login", args: { userid: "mrossi", token: "TOKEN-2", passwd1: "Reimpostata1" } });
    expect(php.ok).toBe(true);
    const ts = await performResetTokenLogin({ userid: "mrossi", token: "TOKEN-2", ip: IP });
    expect(ts).toMatchObject({ ok: true, staffId: 2 });
    expect(await asAgent(2, (ctx) => changeStaffPassword(ctx, { passwd1: "Reimpostata1", passwd2: "Reimpostata1", resetToken: "TOKEN-2" }))).toMatchObject({ ok: true });
    expect(await compareWorkingDatabases({ ignore: ["staff.passwd"] })).toEqual([]);
    expect(comparePassword("Reimpostata1", await staffPasswd(TS_DB, 2))).toBe(true);

    // token errato e utente sconosciuto
    expect(await performResetTokenLogin({ userid: "mrossi", token: "nope", ip: IP })).toEqual({ ok: false, error: "invalid_token" });
    expect((await db().transaction().execute((tx) => sendStaffResetEmail(tx, cfg, "nessuno", IP))).sent).toBe(false);
  });
});

describe("2FA via email: PHP vs TypeScript", () => {
  const VERIFIED = 1760000000;

  it("configurazione dal profilo: config 2fa-email, codice inviato, verifica e backend predefinito", async () => {
    const phpMails = await mailsOf(
      () => runPhp({ op: "profile.2fa", args: { agent: 2, email: "mario@altro.example", verified: VERIFIED, default: "2fa-email" } }),
      1,
    );
    const key = newMfaKey();
    const tsMails = await mailsOf(async () => {
      const r = await asAgent(2, (ctx) => setup2faEmail(ctx, "mario@altro.example", key));
      expect(r.ok).toBe(true);
      if (r.ok) await r.send();
    }, 1);
    const otp = pendingOtpForTests(key);
    expect(otp).toMatch(/^[1-9]\d{5}$/);
    expect(await asAgent(2, (ctx) => verify2faSetup(ctx, key, otp!, VERIFIED))).toBe("ok");
    await asAgent(2, (ctx) => setDefault2fa(ctx, "2fa-email"));
    expect(sortMails(tsMails)).toEqual(sortMails(phpMails));
    expect(await compareWorkingDatabases()).toEqual([]);
  });

  it("login con 2FA: stesse scritture del login più l'email con il codice; verifica e limiti", async () => {
    await execBoth(
      "INSERT INTO {p}config (namespace, `key`, value, updated) VALUES ('staff.2', 'default_2fa', '2fa-email', NOW())",
      `INSERT INTO {p}config (namespace, \`key\`, value, updated) VALUES ('staff.2', '2fa-email', '{"config":{"email":"mrossi@ospedale.example"},"verified":${VERIFIED}}', NOW())`,
    );
    const phpMails = await mailsOf(() => runPhp({ op: "staff.login", args: { login: "mrossi", password: "Passw0rd!dev" }, ip: "10.9.9.1" }), 1);
    let key = "";
    const tsMails = await mailsOf(async () => {
      const r = await performStaffLogin({ login: "mrossi", password: "Passw0rd!dev", ip: "10.9.9.1" });
      expect(r.ok).toBe(true);
      key = r.ok ? (r.mfaKey ?? "") : "";
    }, 1);
    expect(key).not.toBe("");
    expect(phpMails.length).toBe(1);
    expect(sortMails(tsMails)).toEqual(sortMails(phpMails));
    expect(await compareWorkingDatabases()).toEqual([]);
    const otp = pendingOtpForTests(key)!;
    expect(validateOtp(key, 2, "12x")).toBe("invalid");
    expect(validateOtp(key, 2, "000000")).toBe("invalid");
    expect(validateOtp(key, 2, otp)).toBe("ok");
    expect(validateOtp(key, 2, otp)).toBe("missing");
  });
});

describe("tentativi di login falliti: PHP vs TypeScript", () => {
  it("syslog al terzo tentativo, blocco e avviso all'amministratore oltre staff_max_logins", async () => {
    const attempts = Array.from({ length: 5 }, () => ({ login: "lbianchi", password: "errata" }));
    const phpMails = await mailsOf(async () => {
      const r = await runPhp<{ results: string[] }>({ op: "staff.login.many", args: { attempts }, ip: "10.7.7.7" });
      expect(r.results.at(-1)).not.toBe("ok");
    }, 1);
    const tsMails = await mailsOf(async () => {
      const out: string[] = [];
      for (const a of attempts) {
        const r = await performStaffLogin({ ...a, ip: "10.7.7.7" });
        out.push(r.ok ? "ok" : r.error);
      }
      expect(out).toEqual(["invalid", "invalid", "invalid", "invalid", "too_many"]);
    }, 1);
    expect(phpMails.length).toBe(1);
    const norm = (l: typeof phpMails) => l.map((m) => ({ ...m, mid: { ...m.mid, sig: "" } }));
    expect(norm(tsMails)).toEqual(norm(phpMails));
    expect(await compareWorkingDatabases()).toEqual([]);
  });
});
