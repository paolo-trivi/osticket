import "server-only";

import { createHash } from "node:crypto";

import { checkPassword } from "../../auth/passwd";
import { addStrike, isLockedOut, resetStrikes } from "../../auth/strikes";
import { coreConfig, type ConfigNamespace } from "../../config/config";
import { db, type DbOrTx } from "../../db";
import { detectDbTimezone } from "../../db/time";
import { installConfig } from "../../env";
import { phpJsonDecode, phpJsonEncode } from "../../format/php-json";
import { sanitizeText } from "../../format/text";
import { sendMail } from "../../mail/mailer";
import { base32Decode, ticketAuthToken } from "../../mail/message-id";
import { adminAlertMail } from "../../system/admin-alert";
import { logSystem } from "../../system/syslog";
import { isEmail } from "../forms/fields";
import { phpAlertDate } from "../../auth/staff-auth";
import {
  accountIsConfirmed,
  accountIsLocked,
  isUserId,
  loadClientAccount,
  loadClientIdentity,
  lookupAccountByUsername,
  passwordVersion,
  type ClientAccountRow,
  type GuestAccess,
} from "./identity";
import { sendAccessLinkMail } from "./mails";

/**
 * Autenticazione dei clienti (include/class.auth.php: UserAuthenticationBackend, UserAuthStrikeBackend,
 * osTicketClientAuthentication, AccessLinkAuthentication, AuthTokenAuthentication,
 * ClientPasswordResetTokenBackend, ClientAcctConfirmationTokenBackend). Qui solo la parte di dominio
 * (righe del DB, email, syslog): la sessione HTTP è in src/server/auth/client-auth.ts.
 *
 * Scritture al login riuscito (UserAuthenticationBackend::login), come il PHP:
 *  - syslog "User login" (Debug) `<email> (<id>) logged in [<ip>]`;
 *  - DELETE config namespace "pwreset" value "c<uid>" (cancelResetTokens, solo backend interattivi);
 *  - user_account.extra.browser_lang (ClientAccount::onLogin, se l'utente ha un account);
 *  - eventuale rehash da MD5 della password (ClientAccount::check_passwd).
 * La tabella user_account non ha una colonna lastlogin: il PHP non registra l'ultimo accesso dei clienti.
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
  | "reset_failed";

export interface ClientLogin {
  userId: number;
  /** versione della password per la validità della sessione */
  pwv: string;
  guest: GuestAccess | null;
  /** token di reset con cui si è entrati ($_SESSION['_client']['reset-token']) */
  resetToken?: string;
}

type ClientAuthOutcome = ({ ok: true } & ClientLogin) | { ok: false; error: ClientAuthError };

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

function lockedOut(cfg: ConfigNamespace, ip: string): boolean {
  return isLockedOut(REALM, ip, "", lockoutSeconds(cfg));
}

/** UserAuthStrikeBackend::authStrike: tentativo fallito, log e avviso all'amministratore. */
async function strike(cfg: ConfigNamespace, username: string, ip: string): Promise<void> {
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
async function denied(cfg: ConfigNamespace, username: string, ip: string, error: ClientAuthError): Promise<ClientAuthOutcome> {
  await strike(cfg, username, ip);
  return { ok: false, error };
}

/**
 * UserAuthenticationBackend::login: controlli dell'account e scritture del login.
 * Restituisce l'errore (AccessDenied) oppure la versione della password per la sessione.
 */
async function loginWrites(
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
    if (Object.keys(set).length) await executor.updateTable("user_account").set(set as never).where("id", "=", acct.id).execute();
    return { ok: true, pwv: passwordVersion(opts.rehash ?? acct.passwd) };
  }
  return { ok: true, pwv: passwordVersion(null) };
}

async function prepare(): Promise<ConfigNamespace> {
  const cfg = await coreConfig();
  await detectDbTimezone(db());
  return cfg;
}

/**
 * login.php (POST luser/lpasswd) → UserAuthenticationBackend::process con osTicketClientAuthentication.
 * Account non confermato o bloccato: AccessDenied, contato come tentativo fallito (come il PHP).
 * Account con backend esterno (LDAP/OAuth): non gestiti dalla app.
 */
export async function performClientLogin(input: { login: string; password: string; ip: string }): Promise<ClientAuthOutcome> {
  const cfg = await prepare();
  const username = input.login.trim();
  const { ip } = input;
  if (!username) return { ok: false, error: "required" };
  if (!isUserId(username)) return { ok: false, error: "invalid_userid" };
  if (lockedOut(cfg, ip)) return denied(cfg, username, ip, "locked_out");

  const acct = await lookupAccountByUsername(db(), username);
  if (acct?.backend && acct.backend !== "client") return { ok: false, error: "backend" };
  const check = acct ? checkPassword(input.password.slice(0, 128), acct.passwd) : ({ ok: false } as const);
  if (!acct || !check.ok) return denied(cfg, username, ip, "invalid");

  const r = await db()
    .transaction()
    .execute((tx) => loginWrites(tx, cfg, acct.user_id, { ip, interactive: true, rehash: check.rehash }));
  if (!r.ok) return denied(cfg, username, ip, r.error);
  resetStrikes(REALM, ip, "");
  return { ok: true, userId: acct.user_id, pwv: r.pwv, guest: null };
}

/** Ticket::lookupByNumber($number) */
async function ticketByNumber(executor: DbOrTx, number: string) {
  if (!number) return null;
  return (await executor.selectFrom("ticket").select(["ticket_id", "user_id", "created", "number"]).where("number", "=", number).executeTakeFirst()) ?? null;
}

/** AccessLinkAuthentication::_getTicketUser: proprietario o collaboratore del ticket */
async function ticketUser(executor: DbOrTx, ticket: { ticket_id: number; user_id: number }, userId: number): Promise<GuestAccess | null> {
  if (ticket.user_id === userId) return { ticketId: ticket.ticket_id, collabId: 0 };
  const c = await executor
    .selectFrom("thread_collaborator as c")
    .innerJoin("thread as th", "th.id", "c.thread_id")
    .select("c.id")
    .where("th.object_type", "=", "T")
    .where("th.object_id", "=", ticket.ticket_id)
    .where("c.user_id", "=", userId)
    .executeTakeFirst();
  return c ? { ticketId: ticket.ticket_id, collabId: c.id } : null;
}

type AccessLinkOutcome = { ok: true; sent: true } | ({ ok: true; sent: false } & ClientLogin) | { ok: false; error: ClientAuthError };

/**
 * login.php (POST lemail/lticket) → AccessLinkAuthentication. Con client_verify_email (default) invia
 * l'email "access-link" con il link firmato e non apre la sessione; altrimenti accesso diretto
 * come ospite. Ogni fallimento è un tentativo (strike).
 */
export async function performAccessLink(input: { email: string; number: string; ip: string }): Promise<AccessLinkOutcome> {
  const cfg = await prepare();
  const { ip } = input;
  const email = input.email.trim();
  if (!isEmail(email)) return { ok: false, error: "invalid_email" };
  if (lockedOut(cfg, ip)) {
    await strike(cfg, email, ip);
    return { ok: false, error: "locked_out" };
  }
  const ticket = await ticketByNumber(db(), String(input.number ?? "").trim());
  const user = await db().selectFrom("user_email").select("user_id").where("address", "=", email).executeTakeFirst();
  const guest = ticket && user ? await ticketUser(db(), ticket, user.user_id) : null;
  if (!ticket || !user || !guest) {
    await strike(cfg, email, ip);
    return { ok: false, error: "invalid" };
  }
  if (cfg.bool("client_verify_email")) {
    // AccessLinkAuthentication::login non apre la sessione; login.php invia il link (Ticket::sendAccessLink)
    await sendAccessLinkMail(db(), cfg, ticket.ticket_id, user.user_id, guest.collabId);
    return { ok: true, sent: true };
  }
  const r = await db()
    .transaction()
    .execute((tx) => loginWrites(tx, cfg, user.user_id, { ip, interactive: false }));
  if (!r.ok) {
    await strike(cfg, email, ip);
    return { ok: false, error: r.error };
  }
  return { ok: true, sent: false, userId: user.user_id, pwv: r.pwv, guest };
}

/** TicketUser::lookupByToken: ospite (proprietario o collaboratore) di un link `?auth=` */
async function lookupByAuthToken(executor: DbOrTx, token: string): Promise<{ userId: number; guest: GuestAccess } | null> {
  const m = /^(\w)(\d+)x(.*)$/i.exec(token);
  if (!m) return null;
  const packed = base32Decode(m[3].slice(0, 13).toLowerCase());
  if (packed.length < 8) return null;
  const uid = packed.readUInt32LE(0);
  const tid = packed.readUInt32LE(4);
  const ticket = await executor.selectFrom("ticket").select(["ticket_id", "user_id", "created"]).where("ticket_id", "=", tid).executeTakeFirst();
  if (!ticket) return null;
  let userId = 0;
  let guest: GuestAccess | null = null;
  let contactId = 0;
  if (m[1] === "c") {
    const c = await executor
      .selectFrom("thread_collaborator as c")
      .innerJoin("thread as th", "th.id", "c.thread_id")
      .select(["c.id", "c.user_id", "th.object_id", "th.object_type"])
      .where("c.id", "=", uid)
      .executeTakeFirst();
    if (c && c.object_type === "T" && c.object_id === tid) {
      userId = c.user_id;
      contactId = c.id;
      guest = { ticketId: tid, collabId: c.id };
    }
  } else if (m[1] === "o") {
    if (ticket.user_id === uid) {
      userId = uid;
      contactId = uid;
      guest = { ticketId: tid, collabId: 0 };
    }
  }
  if (!guest) return null;
  // Ticket::getAuthToken: 'o' se l'id del contatto coincide con il proprietario (anche per un collaboratore)
  const expected = ticketAuthToken({
    isOwner: contactId === ticket.user_id,
    contactId,
    ticketId: tid,
    createDate: ticket.created,
    secretSalt: installConfig().secretSalt,
    algo: Number(m[2]),
  });
  if (Number(m[2]) !== 1 || expected.toLowerCase() !== token.toLowerCase()) return null;
  return { userId, guest };
}

/**
 * view.php?auth=<token> (o i vecchi link ?t=&e=&a=) → AuthTokenAuthentication::signOn tramite
 * processSignOn senza autenticazione forzata: token non valido = nessun accesso, senza strike.
 */
export async function performTokenSignOn(input: { auth?: string; t?: string; e?: string; a?: string; ip: string }): Promise<ClientAuthOutcome | null> {
  const cfg = await prepare();
  const { ip } = input;
  if (lockedOut(cfg, ip)) return denied(cfg, "", ip, "locked_out");
  if (!cfg.bool("allow_auth_tokens")) return null;
  let found: { userId: number; guest: GuestAccess } | null = null;
  if (input.auth) found = await lookupByAuthToken(db(), input.auth);
  else if (input.t && input.e && input.a) {
    // Vecchi token: md5(ticket_id . strtolower(email) . SECRET_SALT), solo per il proprietario
    const row = await db()
      .selectFrom("ticket as t")
      .innerJoin("user_email as e", "e.user_id", "t.user_id")
      .select(["t.ticket_id", "t.user_id"])
      .where("t.number", "=", input.t)
      .where("e.address", "=", input.e)
      .executeTakeFirst();
    const md5 = row ? createHash("md5").update(`${row.ticket_id}${input.e.toLowerCase()}${installConfig().secretSalt}`).digest("hex") : "";
    if (row && md5 === input.a.toLowerCase()) found = { userId: row.user_id, guest: { ticketId: row.ticket_id, collabId: 0 } };
  }
  if (!found) return null;
  const f = found;
  const r = await db()
    .transaction()
    .execute((tx) => loginWrites(tx, cfg, f.userId, { ip, interactive: false }));
  if (!r.ok) return denied(cfg, "", ip, r.error);
  return { ok: true, userId: f.userId, pwv: r.pwv, guest: f.guest };
}

/** Config('pwreset')->get($token) con data di ultima modifica */
async function resetToken(executor: DbOrTx, token: string) {
  if (!token) return null;
  return (await executor.selectFrom("config").select(["value", "updated"]).where("namespace", "=", "pwreset").where("key", "=", token).executeTakeFirst()) ?? null;
}

/** Token più vecchio di pw_reset_window minuti? */
async function tokenExpired(executor: DbOrTx, cfg: ConfigNamespace, updated: string): Promise<boolean> {
  const zone = await detectDbTimezone(executor);
  const { DateTime } = await import("luxon");
  const ts = DateTime.fromSQL(updated, { zone });
  if (!ts.isValid) return true;
  return cfg.int("pw_reset_window") * 60 < Date.now() / 1000 - ts.toSeconds();
}

/**
 * pwreset.php POST do=reset → ClientPasswordResetTokenBackend::signOn (token valido per l'utente e non
 * scaduto → stato "cambio password obbligatorio") e login. Gli errori di signOn non arrivano alla
 * pagina nel PHP ($errors passato per valore): l'esito è "Unknown user" con uno strike; qui il codice.
 */
export async function performResetTokenLogin(input: { userid: string; token: string; ip: string }): Promise<ClientAuthOutcome> {
  const cfg = await prepare();
  const { ip } = input;
  if (lockedOut(cfg, ip)) return denied(cfg, "", ip, "locked_out");
  const userid = input.userid.trim();
  const out = await db()
    .transaction()
    .execute(async (tx): Promise<ClientAuthOutcome> => {
      const acct = await lookupAccountByUsername(tx, userid);
      if (!acct) return { ok: false, error: "invalid_user" };
      const t = await resetToken(tx, input.token);
      if (!t || t.value !== `c${acct.user_id}`) return { ok: false, error: "invalid_token" };
      if (await tokenExpired(tx, cfg, t.updated)) return { ok: false, error: "invalid_token" };
      // UserAccount::forcePasswdReset
      const status = acct.status | 0x0004;
      if (status !== acct.status) await tx.updateTable("user_account").set({ status }).where("id", "=", acct.id).execute();
      const r = await loginWrites(tx, cfg, acct.user_id, { ip, interactive: false });
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, userId: acct.user_id, pwv: r.pwv, guest: null, resetToken: input.token };
    });
  if (!out.ok) return denied(cfg, "", ip, out.error);
  return out;
}

type ConfirmOutcome =
  | ({ ok: true; confirmed: true; forceReset: boolean } & ClientLogin)
  | { ok: true; confirmed: false; form: true }
  | { ok: false; error: ClientAuthError | "not_found" };

/**
 * pwreset.php?token=<token> (GET): se l'account non è confermato lo conferma e apre la sessione
 * (ClientAcctConfirmationTokenBackend); con password locale annulla i token, altrimenti obbliga a
 * impostarla. Se l'account è già confermato il token serve al reset: si mostra il form username.
 */
export async function performConfirm(input: { token: string; ip: string }): Promise<ConfirmOutcome> {
  const cfg = await prepare();
  const { ip } = input;
  const out = await db()
    .transaction()
    .execute(async (tx): Promise<ConfirmOutcome | { ok: false; error: ClientAuthError; strike: true }> => {
      const t = await resetToken(tx, input.token);
      const acct: ClientAccountRow | null = t && /^c\d+$/.test(t.value ?? "") ? await loadClientAccount(tx, Number(t.value!.slice(1)), true) : null;
      if (!t || !acct) return { ok: false, error: "not_found" };
      if (accountIsConfirmed(acct)) return { ok: true, confirmed: false, form: true };
      // UserAccount::confirm
      await tx.updateTable("user_account").set({ status: acct.status | 0x0001 }).where("id", "=", acct.id).execute();
      // processSignOn($errors): strike backend, poi ClientAcctConfirmationTokenBackend
      if (lockedOut(cfg, ip)) return { ok: false, error: "locked_out", strike: true };
      const r = await loginWrites(tx, cfg, acct.user_id, { ip, interactive: false });
      if (!r.ok) return { ok: false, error: r.error, strike: true };
      let forceReset = false;
      if (acct.passwd && !acct.backend) {
        await tx.deleteFrom("config").where("namespace", "=", "pwreset").where("value", "=", `c${acct.user_id}`).execute();
      } else {
        forceReset = true;
        const cur = await tx.selectFrom("user_account").select("status").where("id", "=", acct.id).executeTakeFirstOrThrow();
        if (!(cur.status & 0x0004)) await tx.updateTable("user_account").set({ status: cur.status | 0x0004 }).where("id", "=", acct.id).execute();
      }
      return { ok: true, confirmed: true, forceReset, userId: acct.user_id, pwv: r.pwv, guest: null, ...(forceReset ? { resetToken: input.token } : {}) };
    });
  if (!out.ok && "strike" in out) {
    await strike(cfg, "", ip);
    return { ok: false, error: out.error };
  }
  return out as ConfirmOutcome;
}

/** Validità di un token di reset per l'utente (ClientAccount::update con reset-token in sessione). */
export async function resetTokenValid(executor: DbOrTx, cfg: ConfigNamespace, token: string, userId: number): Promise<boolean> {
  const t = await resetToken(executor, token);
  if (!t || t.value !== `c${userId}`) return false;
  return !(await tokenExpired(executor, cfg, t.updated));
}
