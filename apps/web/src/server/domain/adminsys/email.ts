import "server-only";

import { createHash } from "node:crypto";

import { encrypt, decrypt } from "../../crypto/crypto";
import { type DbOrTx } from "../../db";
import { installConfig } from "../../env";
import { stripTags } from "../../format/html";
import { htmlchars, inArray, intval, isNumeric, isset, phpLooseEquals, str, truthy, type PhpVal, type PhpVars } from "../../php/values";
import { sanitizeHtml as sanitizeText } from "./sanitize";
import type { MassResult, SaveResult } from "../admin/common";
import { ConfigWriter } from "../admin/config-write";
import { OrmRow, SQL_NOW } from "../admin/orm";
import { pv } from "./orm-util";
import { stripEmoticons } from "../../format/text";
import type { Errors } from "../admin/validator";
import { isEmail } from "../forms/validator";
import { connectionErrors, connectionOf, probeMailbox, probeSmtp, type Credentials } from "./mail-probe";

/**
 * Account email di sistema: scp/emails.php → Email::update / Email::create / Email::delete
 * (include/class.email.php) con MailBoxAccount / SmtpAccount (tabella `email_account`) e le
 * credenziali "basic" nel namespace config `email.<email_id>.account.<account_id>` (username +
 * password cifrata con Crypto::encrypt(SECRET_SALT, md5(username . namespace))).
 *
 * Differenze annotate:
 * - OAuth2 (plugin osTicket) non è gestito: la scelta di un backend `oauth2:*` restituisce
 *   l'errore `oauth_unsupported` e la configurazione resta al pannello PHP.
 * - Le prove di connessione (IMAP/POP3/SMTP) sono fatte da mail-probe.ts: i messaggi d'errore
 *   delle eccezioni di Laminas non sono identici.
 * - Email::delete: il Signal object.deleted → Filter::disableFilters chiama
 *   FilterAction::setFilterFlags con una singola azione e va in errore fatale dopo la DELETE
 *   dell'email (account, config e reparti restano orfani). Non si replica: se un'azione "Send an
 *   Email" del filtro usa l'indirizzo come mittente, l'eliminazione è rifiutata.
 */
const MAILBOX_PROTOCOLS = ["IMAP", "POP"];

type AccountType = "mailbox" | "smtp";

const ACCOUNT_VARS: Record<AccountType, string[]> = {
  mailbox: ["active", "host", "port", "protocol", "auth_bk", "folder", "fetchfreq", "fetchmax", "postfetch", "archivefolder"],
  smtp: ["active", "host", "port", "protocol", "auth_bk", "allow_spoofing"],
};

const strcasecmp = (a: PhpVal, b: PhpVal) => str(a).toLowerCase() !== str(b).toLowerCase();

/** Email::getIdByEmail */
async function emailIdByAddress(executor: DbOrTx, address: string): Promise<number | null> {
  const row = await executor.selectFrom("email").select("email_id").where("email", "=", address).executeTakeFirst();
  return row?.email_id ?? null;
}

/** Email::getMailBoxAccount / getSmtpAccount (autoinit: account nuovo non salvato). */
async function loadAccount(executor: DbOrTx, emailId: number, type: AccountType): Promise<OrmRow> {
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

interface AccountCtx {
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

const errMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** MailBoxAccount::setInfo */
async function mailboxSetInfo(ctx: AccountCtx, acc: OrmRow, vars: PhpVars, errors: Errors): Promise<boolean> {
  let creds: Creds = null;
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
    creds = await credentialsOf(ctx, acc, str(vars.mailbox_auth_bk));
    if (creds === "oauth") errors.mailbox_auth_bk = "oauth_unsupported";
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

  if (truthy(pv(acc.get("active"))) && creds && creds !== "oauth") {
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
async function smtpSetInfo(ctx: AccountCtx, acc: OrmRow, vars: PhpVars, errors: Errors): Promise<boolean> {
  let creds: Creds = null;
  const e: Errors = {};
  const auth = vars.smtp_auth_bk;
  if (truthy(vars.smtp_active)) {
    if (!truthy(vars.smtp_host)) e.smtp_host = "host_required";
    if (!truthy(vars.smtp_port)) e.smtp_port = "port_required";
    if (!truthy(auth)) e.smtp_auth_bk = "select_auth";
    else {
      creds = await credentialsOf(ctx, acc, str(auth));
      if (creds === "oauth") e.smtp_auth_bk = "oauth_unsupported";
      else if (!creds) e.smtp_auth_bk = phpLooseEquals(auth ?? null, "mailbox") ? "configure_mailbox_auth" : "configure_auth";
    }
  } else if (truthy(auth) && strcasecmp(auth, "mailbox")) {
    creds = await credentialsOf(ctx, acc, str(auth));
    if (creds === "oauth") e.smtp_auth_bk = "oauth_unsupported";
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
    if (truthy(pv(acc.get("active"))) && creds && creds !== "oauth") {
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

/** scp/emails.php do=update / do=create → Email::update($_POST, $errors) */
export async function saveEmail(executor: DbOrTx, emailId: number | null, vars: PhpVars): Promise<SaveResult> {
  const errors: Errors = {};
  let email: OrmRow;
  if (emailId) {
    const row = await OrmRow.load(executor, "email", "email_id", { email_id: emailId }, { touchUpdated: true });
    if (!row) return { ok: false, errors: { err: "unknown" } };
    email = row;
  } else {
    email = OrmRow.create("email", "email_id", { touchUpdated: true });
    email.set("created", SQL_NOW);
  }
  const name = stripTags(str(vars.name).trim());
  const address = str(vars.email).trim();
  const id = email.isNew ? 0 : email.num("email_id");
  if (id && !phpLooseEquals(id, vars.id ?? null)) errors.err = "internal";

  if (!address || !isEmail(address)) errors.email = "valid_email_required";
  else {
    const eid = await emailIdByAddress(executor, address);
    const cfg = await executor.selectFrom("config").select("value").where("namespace", "=", "core").where("key", "=", "admin_email").executeTakeFirst();
    if (eid && eid !== id) errors.email = "email_exists";
    else if (cfg && cfg.value?.toLowerCase() === address.toLowerCase()) errors.email = "admin_email";
    else if (await executor.selectFrom("staff").select("staff_id").where("email", "=", address).executeTakeFirst()) errors.email = "agent_email";
  }
  if (!truthy(name)) errors.name = "name_required";

  if (!email.isNew) {
    const ctx: AccountCtx = { executor, emailId: id, address: str(pv(email.get("email"))) };
    // Remote Mailbox
    const mailbox = await loadAccount(executor, id, "mailbox");
    ctx.mailbox = mailbox;
    if (await mailboxSetInfo(ctx, mailbox, vars, errors)) await mailbox.save(executor);
    // SMTP
    const smtp = await loadAccount(executor, id, "smtp");
    if (await smtpSetInfo(ctx, smtp, vars, errors)) await smtp.save(executor);
  }
  if (Object.keys(errors).length) return { ok: false, errors };

  email.set("email", sanitizeText(address));
  email.set("name", stripTags(name));
  email.set("dept_id", intval(vars.dept_id));
  email.set("priority_id", isset(vars, "priority_id") ? intval(vars.priority_id) : 0);
  email.set("topic_id", intval(vars.topic_id));
  email.set("noautoresp", intval(vars.noautoresp));
  email.set("notes", sanitizeText(str(vars.notes)));
  await email.save(executor);
  return { ok: true, id: email.num("email_id"), errors: {} };
}

/** Email::delete (le email predefinita e degli avvisi non si eliminano). */
async function deleteEmail(executor: DbOrTx, emailId: number, defaults: { def: number; alert: number }): Promise<"ok" | "refused" | "filter"> {
  if (emailId === defaults.def || emailId === defaults.alert) return "refused";
  const used = await executor
    .selectFrom("filter_action")
    .select("id")
    .where("type", "=", "email")
    .where("configuration", "like", `%"from":${emailId}}`)
    .executeTakeFirst();
  if (used) return "filter";
  await executor.deleteFrom("email").where("email_id", "=", emailId).execute();
  for (const type of ["mailbox", "smtp"] as const) {
    const acc = await executor.selectFrom("email_account").select(["id", "auth_bk"]).where("type", "=", type).where("email_id", "=", emailId).executeTakeFirst();
    if (!acc) continue;
    // destroyConfig(): Config::destroy() del namespace dell'account
    await executor.deleteFrom("config").where("namespace", "=", `email.${emailId}.account.${acc.id}`).execute();
    await executor.deleteFrom("email_account").where("id", "=", acc.id).execute();
  }
  await executor.updateTable("department").set({ email_id: defaults.def }).where("email_id", "=", emailId).execute();
  await executor.updateTable("department").set({ autoresp_email_id: 0 }).where("autoresp_email_id", "=", emailId).execute();
  return "ok";
}

/** scp/emails.php do=mass_process a=delete */
export async function massDeleteEmails(executor: DbOrTx, ids: number[]): Promise<MassResult> {
  if (!ids.length) return { ok: false, num: 0, error: "select_one" };
  const cfg = await executor.selectFrom("config").select(["key", "value"]).where("namespace", "=", "core").where("key", "in", ["default_email_id", "alert_email_id"]).execute();
  const get = (k: string) => intval(cfg.find((c) => c.key === k)?.value ?? "");
  const defaults = { def: get("default_email_id"), alert: get("alert_email_id") };
  let i = 0;
  let filterRef = false;
  for (const id of ids) {
    if (id === defaults.def) continue;
    const exists = await executor.selectFrom("email").select("email_id").where("email_id", "=", id).executeTakeFirst();
    if (!exists) continue;
    const r = await deleteEmail(executor, id, defaults);
    if (r === "ok") i++;
    else if (r === "filter") filterRef = true;
  }
  if (i) return { ok: true, num: i };
  return { ok: false, num: 0, error: filterRef ? "referenced_by_filter" : "failed" };
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

/** Valori correnti degli account per il form (Email::getInfo). */
export async function emailInfo(executor: DbOrTx, emailId: number): Promise<Record<string, string> | null> {
  const email = await executor.selectFrom("email").selectAll().where("email_id", "=", emailId).executeTakeFirst();
  if (!email) return null;
  const info: Record<string, string> = {};
  for (const [k, v] of Object.entries(email)) info[k] = v === null ? "" : String(v);
  for (const type of ["mailbox", "smtp"] as const) {
    const acc = await executor.selectFrom("email_account").selectAll().where("type", "=", type).where("email_id", "=", emailId).executeTakeFirst();
    if (!acc) continue;
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
  return info;
}

/** Elenco (include/staff/emails.inc.php). */
export async function listEmails(executor: DbOrTx) {
  return executor
    .selectFrom("email as e")
    .leftJoin("department as d", "d.id", "e.dept_id")
    .leftJoin("ticket_priority as p", "p.priority_id", "e.priority_id")
    .select(["e.email_id", "e.email", "e.name", "e.created", "e.updated", "d.name as dept", "p.priority_desc as priority"])
    .orderBy("e.email")
    .execute();
}
