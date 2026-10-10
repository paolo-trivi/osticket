import "server-only";

import { cache } from "react";

import { coreConfig } from "../config/config";
import { NOW, db } from "../db";
import { detectDbTimezone } from "../db/time";
import { findStaffIdForLogin, loadAgent, type Agent } from "../domain/staff/staff";
import { phpJsonDecode, phpJsonEncode } from "../format/php-json";
import { logSystem } from "../system/syslog";
import { canWrite, withWriteScope, writeIfAllowed } from "../system/write-mode";
import { burnPasswordCheck, checkPassword } from "./passwd";
import { clearSession, clientIp, readSession, writeSession } from "./session";
import { addStrike, isLockedOut, resetStrikes } from "./strikes";
import { EMAIL_2FA, newMfaKey, prepare2faEmail } from "./mfa";
import { adminAlertMail } from "../system/admin-alert";
import { sendMail } from "../mail/mailer";
import { sanitizeText } from "../format/text";

export type StaffLoginError = "invalid" | "locked_out" | "too_many" | "inactive" | "backend" | "mfa_unsupported";

export type StaffLoginResult = { ok: true; mustChangePassword: boolean; mfa?: boolean } | { ok: false; error: StaffLoginError };

/** Esito della parte di dominio del login (senza cookie/sessione HTTP): usata anche dall'harness. */
type StaffAuthOutcome =
  | {
      ok: true;
      staffId: number;
      passwdVersion: string;
      mustChangePassword: boolean;
      mfaKey?: string;
    }
  | { ok: false; error: StaffLoginError };

/** Backend di autenticazione che la app sa gestire (staff.backend NULL = qualunque, cioè locale). */
const SUPPORTED_BACKENDS = new Set(["", "local"]);

/**
 * Login agente: AuthenticationBackend::process + osTicketStaffAuthentication + StaffAuthStrikeBackend
 * (include/class.auth.php). Scritture identiche al PHP in caso di successo:
 *  - staff.extra.browser_lang, staff.lastlogin = NOW(), staff.updated = NOW()  (Staff::onLogin)
 *  - DELETE config namespace "pwreset" con value = staff_id                  (cancelResetTokens)
 *  - eventuale rehash da MD5 (staff.passwd + updated)                        (check_passwd)
 *  - syslog "Agent Login" a livello Debug                                     (logDebug)
 * Scritture "operational" (write-mode.ts); in sola lettura il login riesce senza scriverle.
 */
export async function performStaffLogin(input: { login: string; password: string; ip: string }): Promise<StaffAuthOutcome> {
  const { password, ip } = input;
  const cfg = await coreConfig();
  const username = input.login.trim();
  await detectDbTimezone(db());

  if (isLockedOut("staff", ip, username, cfg.int("staff_login_timeout") * 60)) {
    return { ok: false, error: "locked_out" };
  }

  const staffId = await findStaffIdForLogin(username);
  const row = staffId
    ? await db()
        .selectFrom("staff")
        .select(["staff_id", "username", "passwd", "backend", "isactive"])
        .where("staff_id", "=", staffId)
        .executeTakeFirst()
    : undefined;

  const backend = (row?.backend ?? "").toLowerCase();
  if (row && !SUPPORTED_BACKENDS.has(backend)) {
    // Account gestito da un backend esterno (LDAP, OAuth...) non ancora supportato dalla app
    return { ok: false, error: "backend" };
  }

  if (!row) burnPasswordCheck(password);
  const check = row ? checkPassword(password, row.passwd) : { ok: false as const };
  if (!row || !check.ok) {
    return failed(username, ip, cfg.int("staff_max_logins"), cfg.int("staff_login_timeout"));
  }
  if (!row.isactive) return { ok: false, error: "inactive" };

  const agent = await loadAgent(row.staff_id);
  if (!agent) return failed(username, ip, cfg.int("staff_max_logins"), cfg.int("staff_login_timeout"));
  const twofa = agent.config.str("default_2fa");
  if (twofa && twofa !== EMAIL_2FA) {
    // Backend 2FA di plugin (TOTP…) non gestiti dalla app: l'agente usa il PHP
    return { ok: false, error: "mfa_unsupported" };
  }

  // Staff::onLogin e cancelResetTokens: scritture accessorie, saltate in sola lettura
  const login = {
    op: "agent.login",
    actor: { type: "agent" as const, id: agent.id },
  };
  await writeIfAllowed("operational", login, () =>
    db()
      .transaction()
      .execute(async (tx) => {
        const extra = phpJsonDecode<Record<string, unknown>>(agent.row.extra, {});
        extra.browser_lang = agent.row.lang || cfg.str("system_language", "en_US");
        await tx
          .updateTable("staff")
          .set({
            extra: phpJsonEncode(extra),
            lastlogin: NOW,
            updated: NOW,
            ...(check.rehash ? { passwd: check.rehash } : {}),
          })
          .where("staff_id", "=", agent.id)
          .execute();
        await tx.deleteFrom("config").where("namespace", "=", "pwreset").where("value", "=", String(agent.id)).execute();
      }),
  );

  await withWriteScope("operational", () => logSystem("Debug", "Agent Login", `${agent.username} logged in [${ip}], via osTicketStaffAuthentication`, ip), login);

  // StaffAuthenticationBackend::login: secondo fattore via email (Email2FABackend::send). Senza
  // configurazione del backend il PHP completa il login senza 2FA: comportamento replicato.
  let mfaKey: string | undefined;
  if (twofa === EMAIL_2FA) {
    const key = newMfaKey();
    const send = await prepare2faEmail(db(), cfg, agent, key);
    if (send) {
      mfaKey = key;
      await send();
    }
  }

  resetStrikes("staff", ip, username);
  const fresh = await db()
    .selectFrom("staff")
    .select(["passwdreset", "change_passwd"])
    .where("staff_id", "=", agent.id)
    .executeTakeFirstOrThrow();
  return {
    ok: true,
    staffId: agent.id,
    passwdVersion: fresh.passwdreset ?? "",
    mustChangePassword: !!fresh.change_passwd,
    ...(mfaKey ? { mfaKey } : {}),
  };
}

/** Login dal form: dominio + cookie di sessione. */
export async function staffLogin(login: string, password: string): Promise<StaffLoginResult> {
  const ip = await clientIp();
  const outcome = await performStaffLogin({ login, password, ip });
  if (!outcome.ok) return outcome;
  await writeSession({
    realm: "staff",
    uid: outcome.staffId,
    pwv: outcome.passwdVersion,
    ip,
    last: Math.floor(Date.now() / 1000),
    ...(outcome.mfaKey ? { mfa: "pending" as const, mfk: outcome.mfaKey } : {}),
  });
  const mustChangePassword = outcome.mustChangePassword && (await canWrite("operational"));
  return {
    ok: true,
    mustChangePassword,
    ...(outcome.mfaKey ? { mfa: true } : {}),
  };
}

async function failed(
  username: string,
  ip: string,
  maxLogins: number,
  timeoutMin: number,
): Promise<StaffAuthOutcome> {
  const { strikes, lockedOut } = addStrike("staff", ip, username, maxLogins);
  const time = phpAlertDate(new Date());
  if (lockedOut) {
    const title = `Excessive login attempts (${username})`;
    const message =
      `Excessive login attempts by an agent?\nUsername: ${username}\nIP: ${ip}\nTime: ${time}\n\n` +
      `Attempts: ${strikes}\nTimeout: ${timeoutMin} ${timeoutMin === 1 ? "minute" : "minutes"}\n\n`;
    // $ost->logWarning($title, $alert, $cfg->alertONLoginError()): syslog e avviso all'amministratore
    // osTicket::log salva Format::sanitize($message): a capo e spazi compressi dall'HTML sanificato
    const logged = await logSystem("Warning", title, sanitizeText(message), ip);
    const cfg = await coreConfig();
    if (logged && cfg.int("send_login_errors") === 1 && cfg.int("log_level") >= 2) {
      try {
        await sendMail(await adminAlertMail(cfg, title, message));
      } catch (err) {
        console.error("[staff-auth] avviso all'amministratore non inviato", err);
      }
    }
    return { ok: false, error: "too_many" };
  }
  if (strikes % 3 === 0) {
    await logSystem(
      "Warning",
      `Failed agent login attempt (${username})`,
      sanitizeText(`Username: ${username}\nIP: ${ip}\nTime: ${time}\n\nAttempts: ${strikes}`),
      ip,
    );
  }
  return { ok: false, error: "invalid" };
}

/**
 * Agente della sessione (StaffAuthenticationBackend::getUser + controlli di staff.inc.php): account
 * attivo, password non cambiata dopo il login, timeout di inattività, binding IP. NON controlla il
 * cambio password obbligatorio: da usare solo per il profilo (cambio password) e il logout.
 */
export const sessionAgent = cache(async (): Promise<Agent | null> => {
  const session = await readSession("staff");
  if (!session || session.mfa) return null;
  const cfg = await coreConfig();
  await detectDbTimezone(db());

  const timeout = cfg.int("staff_session_timeout") * 60;
  const now = Math.floor(Date.now() / 1000);
  if (timeout > 0 && now - session.last > timeout) return null;
  if (cfg.bool("staff_ip_binding") && session.ip !== (await clientIp())) return null;

  const agent = await loadAgent(session.uid);
  if (!agent || !agent.isActive) return null;
  if ((agent.row.passwdreset ?? "") !== session.pwv) return null;
  return agent;
});

/**
 * Agente della richiesta corrente per pagine, server action e route handler: come sessionAgent, ma null
 * finché l'agente deve cambiare la password (staff.change_passwd, anche dopo il login con il token di
 * reset): scp/staff.inc.php in questo stato mostra solo profile.php (forcePasswdChange).
 */
export const currentAgent = cache(async (): Promise<Agent | null> => {
  const agent = await sessionAgent();
  return agent && !(await passwordChangeEnforced(agent)) ? agent : null;
});

/**
 * Cambio password obbligatorio da imporre ora: solo se la modalità di scrittura lo consente
 * (write-mode.ts). In sola lettura il form non può salvare: l'agente naviga in consultazione e il
 * cambio torna obbligatorio appena le scritture sono di nuovo permesse.
 */
export async function passwordChangeEnforced(agent: Pick<Agent, "mustChangePassword">): Promise<boolean> {
  return agent.mustChangePassword && (await canWrite("operational"));
}

/** Rinnova il timestamp di attività (da chiamare nelle Server Actions / route handler). */
export async function touchStaffSession(): Promise<void> {
  const session = await readSession("staff");
  if (session) await writeSession({ ...session, last: Math.floor(Date.now() / 1000) });
}

export async function staffLogout(): Promise<void> {
  const agent = await sessionAgent();
  if (agent) {
    const ip = await clientIp();
    await logSystem("Debug", "Agent logout", `${agent.username} logged out [${ip}]`, ip);
  }
  await clearSession("staff");
}

/** date('M j, Y, g:i a T') del PHP (fuso UTC impostato da bootstrap.php) */
export function phpAlertDate(d: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const h = d.getUTCHours();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}, ${h12}:${mm} ${h < 12 ? "am" : "pm"} UTC`;
}
