import "server-only";

import { addStrike, isLockedOut } from "../../auth/strikes";
import { coreConfig, type ConfigNamespace } from "../../config/config";
import { db, type DbOrTx } from "../../db";
import { detectDbTimezone } from "../../db/time";
import { phpJsonDecode, phpJsonEncode } from "../../format/php-json";
import { sanitizeText } from "../../format/text";
import { sendMail } from "../../mail/mailer";
import { adminAlertMail } from "../../system/admin-alert";
import { logSystem } from "../../system/syslog";
import { writeIfAllowed } from "../../system/write-mode";
import { phpAlertDate } from "../../auth/staff-auth";
import { accountIsConfirmed, accountIsLocked, loadClientIdentity, passwordVersion, type GuestAccess } from "./identity";

/**
 * Autenticazione dei clienti (include/class.auth.php: UserAuthenticationBackend, UserAuthStrikeBackend,
 * osTicketClientAuthentication, AccessLinkAuthentication, AuthTokenAuthentication,
 * ClientPasswordResetTokenBackend, ClientAcctConfirmationTokenBackend). Qui solo la parte di dominio
 * (righe del DB, email, syslog): la sessione HTTP è in src/server/auth/client-auth.ts.
 * Qui la base comune (esiti, tentativi falliti, scritture del login); i flussi sono nei moduli vicini:
 * auth-login.ts (login con password), auth-access-link.ts (link di accesso e token `?auth=`),
 * auth-confirm.ts (conferma dell'account), auth-reset.ts (token di reset della password).
 *
 * Scritture al login riuscito (UserAuthenticationBackend::login), come il PHP:
 *  - syslog "User login" (Debug) `<email> (<id>) logged in [<ip>]`;
 *  - DELETE config namespace "pwreset" value "c<uid>" (cancelResetTokens, solo backend interattivi);
 *  - user_account.extra.browser_lang (ClientAccount::onLogin, se l'utente ha un account);
 *  - eventuale rehash da MD5 della password (ClientAccount::check_passwd).
 * La tabella user_account non ha una colonna lastlogin: il PHP non registra l'ultimo accesso dei clienti.
 * Sono scritture accessorie "operational" (write-mode.ts): in sola lettura il login riesce senza di esse.
 */

export type ClientAuthError =
  | "required"
  | "invalid_userid"
  | "invalid_email"
  | "invalid"
  | "locked_out"
  | "unconfirmed"
  | "locked"
  | "backend"
  | "invalid_token"
  | "invalid_user"
  | "reset_failed"
  /** l'operazione richiede scritture non consentite dalla modalità (TAILTICKET_MODE) */
  | "read_only";

export interface ClientLogin {
  userId: number;
  /** versione della password per la validità della sessione */
  pwv: string;
  guest: GuestAccess | null;
  /** token di reset con cui si è entrati ($_SESSION['_client']['reset-token']) */
  resetToken?: string;
}

export type ClientAuthOutcome = ({ ok: true } & ClientLogin) | { ok: false; error: ClientAuthError };

const REALM = "client";

/**
 * Lo strike backend del PHP conta i tentativi falliti per sessione ($_SESSION['_auth']['user']),
 * qualunque sia il nome utente provato (aggirabile scartando il cookie: doc 14). Qui il contatore è per
 * IP, in memoria del processo: più restrittivo, stessa soglia e stessi messaggi.
 * Stranezza replicata: UserAuthStrikeBackend::authTimeout usa staff_login_timeout (non client_login_timeout).
 */
function lockoutSeconds(cfg: ConfigNamespace): number {
  return cfg.int("staff_login_timeout") * 60;
}

export function lockedOut(cfg: ConfigNamespace, ip: string): boolean {
  return isLockedOut(REALM, ip, "", lockoutSeconds(cfg));
}

/** UserAuthStrikeBackend::authStrike: tentativo fallito, log e avviso all'amministratore. */
export async function strike(cfg: ConfigNamespace, username: string, ip: string): Promise<void> {
  const { strikes, lockedOut: over } = addStrike(REALM, ip, "", cfg.int("client_max_logins"));
  const time = phpAlertDate(new Date());
  if (over) {
    const title = "Excessive login attempts (user)";
    const alert = `Excessive login attempts by a user.\nUsername: ${username}\nIP: ${ip}\nTime: ${time}\n\nAttempts: ${strikes}`;
    // $ost->logError($title, $alert, $cfg->alertONLoginError()): syslog e avviso all'amministratore
    const logged = await logSystem("Error", title, sanitizeText(alert), ip);
    if (logged && cfg.int("send_login_errors") === 1 && cfg.int("log_level") >= 1) {
      try {
        await sendMail(await adminAlertMail(cfg, title, alert));
      } catch (err) {
        console.error("[client-auth] avviso all'amministratore non inviato", err);
      }
    }
    // Signal person.login (tipo login, "Excessive login attempts"): nessun ascoltatore nel core
  } else if (strikes % 3 === 0) {
    const alert = `Username: ${username}\nIP: ${ip}\nTime: ${time}\n\nAttempts: ${strikes}`;
    await logSystem("Warning", "Failed login attempt (user)", sanitizeText(alert), ip);
  }
}

/** Esito negativo dopo un AccessDenied: il PHP lo conta sempre come tentativo fallito (authAudit). */
export async function denied(cfg: ConfigNamespace, username: string, ip: string, error: ClientAuthError): Promise<ClientAuthOutcome> {
  await strike(cfg, username, ip);
  return { ok: false, error };
}

/**
 * UserAuthenticationBackend::login: controlli dell'account e scritture del login.
 * Restituisce l'errore (AccessDenied) oppure la versione della password per la sessione.
 */
export async function loginWrites(
  executor: DbOrTx,
  cfg: ConfigNamespace,
  userId: number,
  opts: { ip: string; interactive: boolean; rehash?: string },
): Promise<{ ok: true; pwv: string } | { ok: false; error: "unconfirmed" | "locked" | "invalid" }> {
  const ident = await loadClientIdentity(userId, null, executor);
  if (!ident) return { ok: false, error: "invalid" };
  const acct = ident.account;
  if (acct) {
    if (!accountIsConfirmed(acct)) return { ok: false, error: "unconfirmed" };
    if (accountIsLocked(acct)) return { ok: false, error: "locked" };
  }
  // osTicket::logDebug(_S('User login'), "%1$s (%2$s) logged in [%3$s]"): EndUser::getUserName() = (string) EmailAddress = indirizzo
  await logSystem("Debug", "User login", sanitizeText(`${ident.email} (${ident.id}) logged in [${opts.ip}]`), opts.ip, { executor });
  if (acct) {
    const written = await writeIfAllowed("operational", { actor: { type: "client", id: userId } }, async () => {
      if (opts.interactive) {
        // ClientAccount::cancelResetTokens
        await executor.deleteFrom("config").where("namespace", "=", "pwreset").where("value", "=", `c${userId}`).execute();
      }
      // ClientAccount::onLogin: lingua corrente (getCurrentLanguage senza utente = lingua di sistema;
      // la negoziazione con Accept-Language del PHP non è replicata)
      const extra = phpJsonDecode<Record<string, unknown> | null>(acct.extra, null) ?? {};
      extra.browser_lang = cfg.str("system_language", "en_US");
      const encoded = phpJsonEncode(extra);
      const set: Record<string, unknown> = {};
      if (encoded !== (acct.extra ?? "")) set.extra = encoded;
      if (opts.rehash) set.passwd = opts.rehash;
      if (Object.keys(set).length)
        await executor
          .updateTable("user_account")
          .set(set as never)
          .where("id", "=", acct.id)
          .execute();
      return true;
    });
    // senza il rehash salvato la sessione resta legata alla password attuale
    return {
      ok: true,
      pwv: passwordVersion((written ? opts.rehash : undefined) ?? acct.passwd),
    };
  }
  return { ok: true, pwv: passwordVersion(null) };
}

export async function prepare(): Promise<ConfigNamespace> {
  const cfg = await coreConfig();
  await detectDbTimezone(db());
  return cfg;
}
