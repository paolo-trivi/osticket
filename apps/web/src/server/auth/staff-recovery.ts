import "server-only";

import { coreConfig } from "../config/config";
import { NOW, db } from "../db";
import { detectDbTimezone } from "../db/time";
import { loadAgent } from "../domain/staff/staff";
import { sendStaffResetEmail, verifyStaffResetToken } from "../domain/staff/password-reset";
import { phpJsonDecode, phpJsonEncode } from "../format/php-json";
import { logSystem } from "../system/syslog";
import { EMAIL_2FA, newMfaKey, prepare2faEmail, validateOtp, type OtpCheck } from "./mfa";
import { clearSession, clientIp, readSession, writeSession } from "./session";

/**
 * Recupero accesso e secondo fattore degli agenti (scp/login.php do=2fa, scp/pwreset.php).
 * Le scritture sul DB sono quelle del PHP; lo stato di sessione è nel cookie firmato della app.
 */

/** Sessione con 2FA pendente (login riuscito, codice non ancora verificato). */
export async function pendingMfaSession(): Promise<{ uid: number } | null> {
  const s = await readSession("staff");
  if (!s || s.mfa !== "pending" || !s.mfk) return null;
  return { uid: s.uid };
}

/**
 * scp/login.php do=2fa: codice valido → sessione completa; troppi tentativi o codice scaduto →
 * logout (syslog "Agent logout" come StaffAuthenticationBackend::signOut) e ritorno al login.
 */
export async function completeMfaLogin(code: string): Promise<OtpCheck> {
  const s = await readSession("staff");
  if (!s || s.mfa !== "pending" || !s.mfk) return "missing";
  const r = validateOtp(s.mfk, s.uid, code);
  if (r === "ok") {
    const rest = { ...s };
    delete rest.mfa;
    delete rest.mfk;
    await writeSession({ ...rest, last: Math.floor(Date.now() / 1000) });
  } else if (r === "expired" || r === "too_many" || r === "missing") {
    const agent = await loadAgent(s.uid);
    const ip = await clientIp();
    if (agent) await logSystem("Debug", "Agent logout", `${agent.username} logged out [${ip}]`, ip);
    await clearSession("staff");
  }
  return r;
}

/** Annulla un login con 2FA pendente. */
export async function cancelPendingLogin(): Promise<void> {
  await clearSession("staff");
}

/**
 * scp/pwreset.php do=sendmail: nessuna informazione sull'esistenza dell'agente (stessa risposta) e
 * tempo minimo di risposta di 1,4 s + jitter, come il PHP.
 */
export async function requestStaffPasswordReset(userid: string): Promise<{ error?: "unavailable" | "disabled" }> {
  const start = Date.now();
  const cfg = await coreConfig();
  if (!cfg.bool("allow_pw_reset")) return { error: "disabled" };
  await detectDbTimezone(db());
  const ip = await clientIp();
  let send: (() => Promise<void>) | undefined;
  let error: "unavailable" | undefined;
  await db()
    .transaction()
    .execute(async (tx) => {
      const r = await sendStaffResetEmail(tx, cfg, userid.trim(), ip);
      send = r.send;
      error = r.error;
    });
  if (send) {
    try {
      await send();
    } catch (err) {
      console.error("[pwreset] invio non riuscito", err);
    }
  }
  const target = 1400 + Math.floor(Math.random() * 251);
  const elapsed = Date.now() - start;
  if (elapsed < target) await new Promise((r) => setTimeout(r, target - elapsed));
  return error ? { error } : {};
}

/**
 * scp/pwreset.php do=newpasswd: PasswordResetTokenBackend::signOn (token valido → change_passwd = 1)
 * e login (syslog "Agent Login … via PasswordResetTokenBackend", Staff::onLogin; il token resta fino
 * al cambio password). Restituisce l'esito; in caso di successo la sessione porta il token di reset.
 */
export async function staffResetTokenLogin(userid: string, token: string): Promise<{ ok: true; mfa: boolean } | { ok: false; error: "invalid_user" | "invalid_token" | "inactive" }> {
  const ip = await clientIp();
  const r = await performResetTokenLogin({ userid, token, ip });
  if (!r.ok) return r;
  await writeSession({
    realm: "staff",
    uid: r.staffId,
    pwv: r.passwdVersion,
    ip,
    last: Math.floor(Date.now() / 1000),
    rst: token,
    ...(r.mfaKey ? { mfa: "pending" as const, mfk: r.mfaKey } : {}),
  });
  return { ok: true, mfa: !!r.mfaKey };
}

/** Parte di dominio di staffResetTokenLogin (senza cookie): usata anche dall'harness. */
export async function performResetTokenLogin(input: { userid: string; token: string; ip: string }): Promise<
  { ok: true; staffId: number; passwdVersion: string; mfaKey?: string } | { ok: false; error: "invalid_user" | "invalid_token" | "inactive" }
> {
  const cfg = await coreConfig();
  await detectDbTimezone(db());
  const { ip } = input;
  const v = await db()
    .transaction()
    .execute((tx) => verifyStaffResetToken(tx, cfg, input.userid.trim(), input.token));
  if (!v.ok) return v;
  const agent = await loadAgent(v.staffId);
  if (!agent || !agent.isActive) return { ok: false, error: "inactive" };
  await logSystem("Debug", "Agent Login", `${agent.username} logged in [${ip}], via PasswordResetTokenBackend`, ip);
  let mfaKey: string | undefined;
  if (agent.config.str("default_2fa") === EMAIL_2FA) {
    const key = newMfaKey();
    const send = await prepare2faEmail(db(), cfg, agent, key);
    if (send) {
      mfaKey = key;
      await send();
    }
  }
  // Staff::onLogin
  const extra = phpJsonDecode<Record<string, unknown>>(agent.row.extra, {});
  extra.browser_lang = agent.row.lang || cfg.str("system_language", "en_US");
  await db().updateTable("staff").set({ extra: phpJsonEncode(extra), lastlogin: NOW, updated: NOW }).where("staff_id", "=", agent.id).execute();
  const fresh = await db().selectFrom("staff").select("passwdreset").where("staff_id", "=", agent.id).executeTakeFirstOrThrow();
  return { ok: true, staffId: agent.id, passwdVersion: fresh.passwdreset ?? "", ...(mfaKey ? { mfaKey } : {}) };
}

/** Token di reset della sessione corrente (cambio password senza password attuale). */
export async function sessionResetToken(): Promise<string | null> {
  return (await readSession("staff"))?.rst ?? null;
}

/** Dopo il cambio password: sessione aggiornata (nuovo passwdreset, token di reset rimosso). */
export async function refreshSessionAfterPasswordChange(passwdreset: string): Promise<void> {
  const s = await readSession("staff");
  if (!s) return;
  const next = { ...s, pwv: passwdreset, last: Math.floor(Date.now() / 1000) };
  delete next.rst;
  await writeSession(next);
}
