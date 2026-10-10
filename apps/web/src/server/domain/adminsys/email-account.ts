import "server-only";

import { createHash } from "node:crypto";

import { encrypt, decrypt } from "../../crypto/crypto";
import { type DbOrTx } from "../../db";
import { installConfig } from "../../env";
import { stripTags } from "../../format/html";
import { htmlchars, inArray, isNumeric, phpLooseEquals, str, truthy, type PhpVal, type PhpVars } from "../../php/values";
import type { SaveResult } from "../admin/common";
import { ConfigWriter } from "../admin/config-write";
import { OrmRow, SQL_NOW } from "../admin/orm";
import { pv } from "./orm-util";
import { stripEmoticons } from "../../format/text";
import type { Errors } from "../admin/validator";
import { connectionErrors, connectionOf, probeMailbox, probeSmtp, type Credentials } from "./mail-probe";

/**
 * Account di un'email di sistema (include/class.email.php): MailBoxAccount / SmtpAccount (tabella
 * `email_account`) e le credenziali "basic" nel namespace config `email.<email_id>.account.<account_id>`
 * (username + password cifrata con Crypto::encrypt(SECRET_SALT, md5(username . namespace))).
 *
 * Differenze annotate:
 * - OAuth2 (plugin osTicket) non è gestito: la scelta di un backend `oauth2:*` restituisce
 *   l'errore `oauth_unsupported` e la configurazione resta al pannello PHP. Lo stesso per i tipi di
 *   autenticazione di altri plugin (`auth_unsupported`, senza registrare l'errore sull'account).
 * - Un account con autenticazione non gestita (OAuth2, plugin, o SMTP "come la casella" con casella
 *   OAuth2) i cui campi non sono stati modificati non viene toccato (accountUnchanged): il resto del
 *   form si salva, le credenziali e i token restano quelli scritti dal PHP. Il PHP rifarebbe la
 *   prova di connessione con il token e azzererebbe contatore e ultimo errore.
 * - Le prove di connessione (IMAP/POP3/SMTP) sono fatte da mail-probe.ts: i messaggi d'errore
 *   delle eccezioni di Laminas non sono identici.
 */
const MAILBOX_PROTOCOLS = ["IMAP", "POP"];

type AccountType = "mailbox" | "smtp";

const ACCOUNT_VARS: Record<AccountType, string[]> = {
  mailbox: ["active", "host", "port", "protocol", "auth_bk", "folder", "fetchfreq", "fetchmax", "postfetch", "archivefolder"],
  smtp: ["active", "host", "port", "protocol", "auth_bk", "allow_spoofing"],
};

const strcasecmp = (a: PhpVal, b: PhpVal) => str(a).toLowerCase() !== str(b).toLowerCase();

/** Tipi di autenticazione gestiti da TailTicket (EmailAccount::getCredentials): gli altri restano al PHP. */
const KNOWN_AUTH = ["basic", "none", "mailbox"];

/** Autenticazione non gestita: `oauth2:*` o tipo di un plugin (vuoto = nessuna, gestita). */
export function isUnsupportedAuth(bk: PhpVal): boolean {
  const type = str(bk).split(":")[0].toLowerCase();
  return !!type && !KNOWN_AUTH.includes(type);
}

/** Campo dell'account come lo rappresenta il form (null = "", porta 0 = "", flag = "1"/"0"). */
function formValue(field: string, value: PhpVal): string {
  if (field === "active" || field === "allow_spoofing") return truthy(value) ? "1" : "0";
  if (field === "port") return truthy(value) && str(value) !== "0" ? str(value) : "";
  return value === null || value === undefined ? "" : str(value);
}

/**
 * I campi dell'account inviati dal form (`<tipo>_<campo>`) sono uguali a quelli salvati? Il
 * protocollo SMTP è fisso e non fa parte del form.
 */
export function accountUnchanged(type: AccountType, stored: Record<string, PhpVal>, vars: PhpVars): boolean {
  return ACCOUNT_VARS[type].filter((k) => !(type === "smtp" && k === "protocol")).every((k) => formValue(k, stored[k] ?? null) === formValue(k, vars[`${type}_${k}`] ?? null));
}

/** Valori salvati dell'account (per accountUnchanged). */
function storedValues(acc: OrmRow, type: AccountType): Record<string, PhpVal> {
  return Object.fromEntries(ACCOUNT_VARS[type].map((k) => [k, pv(acc.get(k)) as PhpVal]));
}

/** Email::getMailBoxAccount / getSmtpAccount (autoinit: account nuovo non salvato). */
export async function loadAccount(executor: DbOrTx, emailId: number, type: AccountType): Promise<OrmRow> {
  const row = await OrmRow.load(executor, "email_account", "id", { type, email_id: emailId }, { touchUpdated: true });
  if (row) return row;
  // EmailAccount::create(['email_id' => …]): active = 0, created = NOW(), type
  const acc = OrmRow.create("email_account", "id", { touchUpdated: true });
  acc.set("email_id", emailId);
  acc.set("active", 0);
  acc.set("created", SQL_NOW);
  acc.set("type", type);
  return acc;
}

/** EmailAccount::getNamespace(): l'id di un account non ancora salvato vale 0 (sprintf %d). */
function namespaceOf(acc: OrmRow): string {
  return `email.${acc.num("email_id")}.account.${acc.num("id")}`;
}

const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");

/** Credenziali decifrate di un account (EmailAccount::getCredentials) o null. */
type Creds = Credentials | null | "oauth";

export interface AccountCtx {
  executor: DbOrTx;
  emailId: number;
  address: string;
  mailbox?: OrmRow;
}

async function basicCredentials(executor: DbOrTx, acc: OrmRow): Promise<Credentials | null> {
  const ns = namespaceOf(acc);
  const rows = await executor.selectFrom("config").select(["key", "value"]).where("namespace", "=", ns).execute();
  const conf = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  if (conf.username === undefined || conf.username === null || conf.passwd === undefined || conf.passwd === null) return null;
  const password = decrypt(conf.passwd, installConfig().secretSalt, md5(String(conf.username) + ns));
  return { type: "basic", username: String(conf.username), password: password === false ? "" : password };
}

/** EmailAccount::logActivity($error): contatore errori, messaggio e data; save(). */
async function logAccountError(executor: DbOrTx, acc: OrmRow, error: string): Promise<void> {
  acc.set("num_errors", acc.num("num_errors") + 1);
  acc.set("last_error_msg", error);
  acc.set("last_error", SQL_NOW);
  await acc.save(executor);
}

/**
 * EmailAccount::getCredentials($auth, $refresh): con un backend diverso da quello salvato
 * (escluso none/mailbox) non ci sono credenziali; un tipo sconosciuto registra l'errore
 * sull'account (logError → save) come l'eccezione del PHP.
 */
async function credentialsOf(ctx: AccountCtx, acc: OrmRow, auth: string | null): Promise<Creds> {
  const stored = str(pv(acc.get("auth_bk")));
  if (auth && stored.slice(0, auth.length).toLowerCase() !== auth.toLowerCase() && !["none", "mailbox"].includes(auth)) return null;
  const which = auth || stored;
  const [type, provider] = which.split(":");
  switch (type) {
    case "mailbox": {
      const mb = ctx.mailbox ?? (await loadAccount(ctx.executor, ctx.emailId, "mailbox"));
      const bk = str(pv(mb.get("auth_bk")));
      // casella con l'autenticazione di un plugin: nessuna credenziale, senza registrare errori
      if (isUnsupportedAuth(bk) && !bk.toLowerCase().startsWith("oauth2")) return null;
      return bk ? credentialsOf(ctx, mb, bk) : null;
    }
    case "none":
      return { type: "none", username: ctx.address };
    case "basic":
      return basicCredentials(ctx.executor, acc);
    case "oauth2":
      void provider;
      return "oauth";
    default:
      await logAccountError(ctx.executor, acc, `Credentials: ${type}: Unknown Credential Type`);
      return null;
  }
}

/**
 * credentialsOf per il form: un tipo scelto non gestito e diverso da OAuth2 (plugin) non arriva a
 * credentialsOf, che registrerebbe "Unknown Credential Type" sull'account: per il PHP con il plugin
 * il tipo è valido, quindi TailTicket rifiuta il salvataggio senza scrivere nulla.
 */
async function credentialsFor(ctx: AccountCtx, acc: OrmRow, auth: string): Promise<Creds | "unsupported"> {
  if (isUnsupportedAuth(auth) && !auth.toLowerCase().startsWith("oauth2")) return "unsupported";
  return credentialsOf(ctx, acc, auth);
}

const errMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** MailBoxAccount::setInfo */
export async function mailboxSetInfo(ctx: AccountCtx, acc: OrmRow, vars: PhpVars, errors: Errors): Promise<boolean> {
  // autenticazione non gestita e campi invariati: l'account resta com'è (nessuna scrittura)
  if (!acc.isNew && isUnsupportedAuth(pv(acc.get("auth_bk"))) && accountUnchanged("mailbox", storedValues(acc, "mailbox"), vars)) return true;
  let creds: Creds | "unsupported" = null;
  const protocol = vars.mailbox_protocol;
  if (truthy(vars.mailbox_active)) {
    if (!truthy(vars.mailbox_host)) errors.mailbox_host = "host_required";
    if (!truthy(vars.mailbox_port)) errors.mailbox_port = "port_required";
    if (!truthy(protocol)) errors.mailbox_protocol = "select_protocol";
    else if (!inArray(protocol, MAILBOX_PROTOCOLS)) errors.mailbox_protocol = "invalid_protocol";
    if (!truthy(vars.mailbox_auth_bk)) errors.mailbox_auth_bk = "select_auth";
    if (!truthy(vars.mailbox_fetchfreq) || !isNumeric(vars.mailbox_fetchfreq ?? null)) errors.mailbox_fetchfreq = "fetchfreq_required";
    if (!truthy(vars.mailbox_fetchmax) || !isNumeric(vars.mailbox_fetchmax ?? null)) errors.mailbox_fetchmax = "fetchmax_required";
    if (phpLooseEquals(protocol ?? null, "POP") && truthy(vars.mailbox_folder)) errors.mailbox_folder = "pop_no_folders";
    if (!truthy(vars.mailbox_postfetch)) errors.mailbox_postfetch = "postfetch_required";
  }
  if (!strcasecmp(vars.mailbox_postfetch, "archive")) {
    if (phpLooseEquals(protocol ?? null, "POP")) errors.mailbox_postfetch = "pop_no_folders";
    else if (!truthy(vars.mailbox_archivefolder)) errors.mailbox_postfetch = "folder_required";
    else if (!strcasecmp(vars.mailbox_folder, vars.mailbox_archivefolder)) errors.mailbox_postfetch = "archive_same_folder";
  }
  if (truthy(vars.mailbox_auth_bk)) {
    creds = await credentialsFor(ctx, acc, str(vars.mailbox_auth_bk));
    if (creds === "oauth") errors.mailbox_auth_bk = "oauth_unsupported";
    else if (creds === "unsupported") errors.mailbox_auth_bk = "auth_unsupported";
    else if (!creds) errors.mailbox_auth_bk = "configure_auth";
  }
  if (Object.keys(errors).length) return false;

  acc.set("active", truthy(vars.mailbox_active) ? 1 : 0);
  acc.set("host", vars.mailbox_host === undefined ? null : str(vars.mailbox_host));
  acc.set("port", truthy(vars.mailbox_port) ? str(vars.mailbox_port) : 0);
  acc.set("protocol", vars.mailbox_protocol === undefined ? null : str(vars.mailbox_protocol));
  acc.set("auth_bk", truthy(vars.mailbox_auth_bk) ? str(vars.mailbox_auth_bk) : null);
  acc.set("folder", truthy(vars.mailbox_folder) ? str(vars.mailbox_folder) : null);
  acc.set("fetchfreq", truthy(vars.mailbox_fetchfreq) ? str(vars.mailbox_fetchfreq) : 5);
  acc.set("fetchmax", truthy(vars.mailbox_fetchmax) ? str(vars.mailbox_fetchmax) : 30);
  acc.set("postfetch", vars.mailbox_postfetch === undefined ? null : str(vars.mailbox_postfetch));
  acc.set("last_activity", null);
  acc.set("last_error_msg", null);
  acc.set("num_errors", 0);
  // switch ($vars['mailbox_postfetch']) { case 'archive': … default: null }
  acc.set("archivefolder", phpLooseEquals(vars.mailbox_postfetch ?? null, "archive") ? (vars.mailbox_archivefolder === undefined ? null : str(vars.mailbox_archivefolder)) : null);

  if (truthy(pv(acc.get("active"))) && creds && creds !== "oauth" && creds !== "unsupported") {
    try {
      const conn = connectionOf(str(pv(acc.get("host"))), str(pv(acc.get("port"))), str(pv(acc.get("protocol"))));
      const folder = str(pv(acc.get("folder")));
      const archive = str(pv(acc.get("archivefolder")));
      const isImap = conn.protocol === "IMAP";
      const r = await probeMailbox(conn, creds, { folders: folder && isImap ? [folder] : [], create: archive && isImap ? archive : null });
      if (r.missing.length) errors.mailbox_folder = "unknown_folder";
      if (r.notCreated.length) errors.mailbox_archivefolder = "cannot_create_folder";
    } catch (e) {
      errors.mailbox_auth = errMessage(e);
    }
  }
  return !Object.keys(errors).length;
}

/** SmtpAccount::setInfo */
export async function smtpSetInfo(ctx: AccountCtx, acc: OrmRow, vars: PhpVars, errors: Errors): Promise<boolean> {
  // autenticazione non gestita (propria o della casella, con "mailbox") e campi invariati: nessuna scrittura
  const storedAuth = pv(acc.get("auth_bk"));
  const mailboxAuth = ctx.mailbox ? pv(ctx.mailbox.get("auth_bk")) : null;
  const viaMailbox = str(storedAuth).toLowerCase() === "mailbox" && isUnsupportedAuth(mailboxAuth);
  // con "mailbox" serve anche l'autenticazione della casella invariata (altrimenti controlli normali)
  const mailboxAuthKept = !viaMailbox || str(vars.mailbox_auth_bk) === str(mailboxAuth);
  if (!acc.isNew && (isUnsupportedAuth(storedAuth) || viaMailbox) && mailboxAuthKept && accountUnchanged("smtp", storedValues(acc, "smtp"), vars)) return true;
  let creds: Creds | "unsupported" = null;
  const e: Errors = {};
  const auth = vars.smtp_auth_bk;
  if (truthy(vars.smtp_active)) {
    if (!truthy(vars.smtp_host)) e.smtp_host = "host_required";
    if (!truthy(vars.smtp_port)) e.smtp_port = "port_required";
    if (!truthy(auth)) e.smtp_auth_bk = "select_auth";
    else {
      creds = await credentialsFor(ctx, acc, str(auth));
      if (creds === "oauth") e.smtp_auth_bk = "oauth_unsupported";
      else if (creds === "unsupported") e.smtp_auth_bk = "auth_unsupported";
      else if (!creds) e.smtp_auth_bk = phpLooseEquals(auth ?? null, "mailbox") ? "configure_mailbox_auth" : "configure_auth";
    }
  } else if (truthy(auth) && strcasecmp(auth, "mailbox")) {
    creds = await credentialsFor(ctx, acc, str(auth));
    if (creds === "oauth") e.smtp_auth_bk = "oauth_unsupported";
    else if (creds === "unsupported") e.smtp_auth_bk = "auth_unsupported";
    else if (!creds) e.smtp_auth_bk = "configure_auth";
  }
  // Strict matching con mailbox OAuth2: senza token OAuth (non gestito) il controllo fallisce
  if (phpLooseEquals(vars.smtp_active ?? null, 1) && auth === "mailbox" && str(vars.mailbox_auth_bk).startsWith("oauth2")) e.smtp_auth_bk = "resource_owner_mismatch";

  if (!Object.keys(e).length) {
    acc.set("active", truthy(vars.smtp_active) ? 1 : 0);
    acc.set("host", vars.smtp_host === undefined ? null : str(vars.smtp_host));
    acc.set("port", truthy(vars.smtp_port) ? str(vars.smtp_port) : 0);
    acc.set("auth_bk", truthy(auth) ? str(auth) : null);
    acc.set("protocol", "SMTP");
    acc.set("allow_spoofing", truthy(vars.smtp_allow_spoofing) ? 1 : 0);
    acc.set("last_activity", null);
    acc.set("last_error_msg", null);
    acc.set("num_errors", 0);
    if (truthy(pv(acc.get("active"))) && creds && creds !== "oauth" && creds !== "unsupported") {
      try {
        await probeSmtp(connectionOf(str(pv(acc.get("host"))), str(pv(acc.get("port"))), "SMTP"), creds);
      } catch (ex) {
        e.smtp_auth = errMessage(ex);
      }
    }
  }
  Object.assign(errors, e);
  return !Object.keys(errors).length;
}

/**
 * Configurazione dell'autenticazione "basic" di un account (ajax.php/email/<id>/auth/config/<type>/basic
 * → EmailAccount::saveAuth → updateCredentials → updateBasicAuthCredentials).
 * `stash` sono i dati del form principale salvati in sessione dal pannello (host, porta,
 * protocollo correnti): sovrascrivono quelli dell'account e vengono salvati con lui.
 */
export async function saveBasicAuth(
  executor: DbOrTx,
  emailId: number,
  type: AccountType,
  vars: { username?: string; passwd?: string },
  stash: PhpVars = {},
): Promise<SaveResult> {
  const errors: Errors = {};
  const email = await executor.selectFrom("email").select(["email_id", "email"]).where("email_id", "=", emailId).executeTakeFirst();
  if (!email) return { ok: false, errors: { err: "unknown" } };
  const acc = await loadAccount(executor, emailId, type);
  const ctx: AccountCtx = { executor, emailId, address: email.email };
  // getCredentialsVars('basic')
  const current = await credentialsOf(ctx, acc, "basic");
  const currentPw = current && current !== "oauth" ? (current.password ?? "") : "";
  // getBasicAuthConfigForm: con POST e credenziali esistenti la password mancante è quella attuale
  const passwd = vars.passwd !== undefined ? vars.passwd : currentPw || undefined;
  // BasicAuthConfigForm::isValid: username obbligatorio (non viene fatto trim), password obbligatoria
  const username = stripEmoticons(stripTags(str(vars.username)));
  // il campo password è obbligatorio quando il valore inviato è vuoto (anche con una password salvata)
  const formErrors: Errors = {};
  if (!username) formErrors.username = "username_required";
  else if (!/(^[^=+@-].*$)|(^\+\d+$)/s.test(str(htmlchars(username)))) formErrors.username = "formula";
  if (!passwd) formErrors.passwd = "password_required";
  if (Object.keys(formErrors).length) return { ok: false, errors: formErrors };

  // getAccountSetting(true): host/porta/protocollo dai dati "stashati" (array_filter)
  for (const p of ["host", "port", "protocol"]) {
    const v = stash[`${type}_${p}`];
    if (truthy(v)) acc.set(p, str(v));
  }
  const conn = connectionOf(str(pv(acc.get("host"))), str(pv(acc.get("port"))), str(pv(acc.get("protocol"))));
  const connErrors = connectionErrors(conn);
  if (connErrors.length) errors.err = connErrors.join(", ");
  else {
    const cred: Credentials = { type: "basic", username, password: passwd || currentPw };
    try {
      if (type === "smtp") await probeSmtp(conn, cred);
      else await probeMailbox(conn, cred);
    } catch (e) {
      errors.err = errMessage(e);
    }
  }
  if (Object.keys(errors).length) return { ok: false, errors };

  const ns = namespaceOf(acc);
  const enc = encrypt(passwd || currentPw, installConfig().secretSalt, md5(username + ns));
  // Bug PHP replicato: SmtpAccount::getConfig() con l'autenticazione salvata "mailbox" restituisce la
  // config dell'account mailbox, quindi le credenziali finiscono nel suo namespace (cifrate però con
  // il namespace dell'account SMTP) e l'account SMTP resta senza credenziali.
  let confNs = ns;
  if (type === "smtp" && str(pv(acc.get("auth_bk"))).toLowerCase() === "mailbox") confNs = namespaceOf(await loadAccount(executor, emailId, "mailbox"));
  const conf = await ConfigWriter.load(executor, confNs);
  await conf.updateAll(executor, { username, passwd: enc === false ? false : enc });
  acc.set("auth_bk", "basic");
  await acc.save(executor);
  return { ok: true, id: acc.num("id"), errors: {} };
}

/** Valori correnti di un account per il form (parte di Email::getInfo): campi, errori e credenziali. */
export async function accountInfo(executor: DbOrTx, emailId: number, type: AccountType, info: Record<string, string>): Promise<void> {
  const acc = await executor.selectFrom("email_account").selectAll().where("type", "=", type).where("email_id", "=", emailId).executeTakeFirst();
  if (!acc) return;
  for (const k of ACCOUNT_VARS[type]) {
    const v = (acc as Record<string, unknown>)[k];
    if (v !== null && v !== undefined) info[`${type}_${k}`] = String(v);
  }
  info[`${type}_id`] = String(acc.id);
  info[`${type}_num_errors`] = String(acc.num_errors);
  info[`${type}_last_error_msg`] = acc.last_error_msg ?? "";
  const conf = await executor.selectFrom("config").select(["key", "value"]).where("namespace", "=", `email.${emailId}.account.${acc.id}`).execute();
  const user = conf.find((c) => c.key === "username");
  if (user) info[`${type}_username`] = user.value ?? "";
  info[`${type}_has_password`] = conf.some((c) => c.key === "passwd" && c.value) ? "1" : "";
}
