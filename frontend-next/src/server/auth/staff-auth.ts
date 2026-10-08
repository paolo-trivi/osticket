import "server-only";

import { cache } from "react";

import { coreConfig } from "../config/config";
import { NOW, db } from "../db";
import { detectDbTimezone } from "../db/time";
import { findStaffIdForLogin, loadAgent, type Agent } from "../domain/staff/staff";
import { phpJsonDecode, phpJsonEncode } from "../format/php-json";
import { logSystem } from "../system/syslog";
import { checkPassword } from "./passwd";
import { clearSession, clientIp, readSession, writeSession } from "./session";
import { addStrike, isLockedOut, resetStrikes } from "./strikes";

export type StaffLoginError = "invalid" | "locked_out" | "too_many" | "inactive" | "backend" | "mfa_unsupported";

export type StaffLoginResult = { ok: true; mustChangePassword: boolean } | { ok: false; error: StaffLoginError };

/** Esito della parte di dominio del login (senza cookie/sessione HTTP): usata anche dall'harness. */
export type StaffAuthOutcome =
  | { ok: true; staffId: number; passwdVersion: string; mustChangePassword: boolean }
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
 */
export async function performStaffLogin(input: {
  login: string;
  password: string;
  ip: string;
}): Promise<StaffAuthOutcome> {
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

  const check = row ? checkPassword(password, row.passwd) : { ok: false as const };
  if (!row || !check.ok) {
    return failed(username, ip, cfg.int("staff_max_logins"), cfg.int("staff_login_timeout"));
  }
  if (!row.isactive) return { ok: false, error: "inactive" };

  const agent = await loadAgent(row.staff_id);
  if (!agent) return failed(username, ip, cfg.int("staff_max_logins"), cfg.int("staff_login_timeout"));
  if (agent.config.str("default_2fa")) {
    // TODO(M2): 2FA via email (Email2FABackend) richiede il mailer; per ora l'agente usa il PHP
    return { ok: false, error: "mfa_unsupported" };
  }

  await db().transaction().execute(async (tx) => {
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
    await tx
      .deleteFrom("config")
      .where("namespace", "=", "pwreset")
      .where("value", "=", String(agent.id))
      .execute();
  });

  await logSystem(
    "Debug",
    "Agent Login",
    `${agent.username} logged in [${ip}], via osTicketStaffAuthentication`,
    ip,
  );

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
  });
  return { ok: true, mustChangePassword: outcome.mustChangePassword };
}

async function failed(
  username: string,
  ip: string,
  maxLogins: number,
  timeoutMin: number,
): Promise<StaffAuthOutcome> {
  const { strikes, lockedOut } = addStrike("staff", ip, username, maxLogins);
  const time = new Date().toUTCString();
  if (lockedOut) {
    await logSystem(
      "Warning",
      `Excessive login attempts (${username})`,
      `Excessive login attempts by an agent?\nUsername: ${username}\nIP: ${ip}\nTime: ${time}\n\n` +
        `Attempts: ${strikes}\nTimeout: ${timeoutMin} ${timeoutMin === 1 ? "minute" : "minutes"}\n\n`,
      ip,
    );
    return { ok: false, error: "too_many" };
  }
  if (strikes % 3 === 0) {
    await logSystem(
      "Warning",
      `Failed agent login attempt (${username})`,
      `Username: ${username}\nIP: ${ip}\nTime: ${time}\n\nAttempts: ${strikes}`,
      ip,
    );
  }
  return { ok: false, error: "invalid" };
}

/**
 * Agente della richiesta corrente (StaffAuthenticationBackend::getUser + controlli di staff.inc.php):
 * account attivo, password non cambiata dopo il login, timeout di inattività, binding IP.
 */
export const currentAgent = cache(async (): Promise<Agent | null> => {
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

/** Rinnova il timestamp di attività (da chiamare nelle Server Actions / route handler). */
export async function touchStaffSession(): Promise<void> {
  const session = await readSession("staff");
  if (session) await writeSession({ ...session, last: Math.floor(Date.now() / 1000) });
}

export async function staffLogout(): Promise<void> {
  const agent = await currentAgent();
  if (agent) {
    const ip = await clientIp();
    await logSystem("Debug", "Agent logout", `${agent.username} logged out [${ip}]`, ip);
  }
  await clearSession("staff");
}
