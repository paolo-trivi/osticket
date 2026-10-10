import "server-only";

import { type DbOrTx } from "../../db";
import { stripTags } from "../../format/html";
import { intval, isset, phpLooseEquals, str, truthy, type PhpVars } from "../../php/values";
import { sanitizeHtml as sanitizeText } from "./sanitize";
import type { MassResult, SaveResult } from "../admin/common";
import { OrmRow, SQL_NOW } from "../admin/orm";
import { pv } from "./orm-util";
import type { Errors } from "../admin/validator";
import { isEmail } from "../forms/validator";
import { accountInfo, loadAccount, mailboxSetInfo, smtpSetInfo, type AccountCtx } from "./email-account";

/**
 * Email di sistema: scp/emails.php → Email::update / Email::create / Email::delete
 * (include/class.email.php). Gli account mailbox/SMTP e le loro credenziali sono in email-account.ts.
 *
 * Differenza annotata: Email::delete: il Signal object.deleted → Filter::disableFilters chiama
 * FilterAction::setFilterFlags con una singola azione e va in errore fatale dopo la DELETE
 * dell'email (account, config e reparti restano orfani). Non si replica: se un'azione "Send an
 * Email" del filtro usa l'indirizzo come mittente, l'eliminazione è rifiutata.
 */

/** Email::getIdByEmail */
async function emailIdByAddress(executor: DbOrTx, address: string): Promise<number | null> {
  const row = await executor.selectFrom("email").select("email_id").where("email", "=", address).executeTakeFirst();
  return row?.email_id ?? null;
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
  // Nuovo indirizzo con "Predefinito di sistema" (0): per l'ORM del PHP null == 0 non è una modifica,
  // quindi l'INSERT prende il default della colonna (2, Normal); comportamento del PHP mantenuto
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

/** Valori correnti degli account per il form (Email::getInfo). */
export async function emailInfo(executor: DbOrTx, emailId: number): Promise<Record<string, string> | null> {
  const email = await executor.selectFrom("email").selectAll().where("email_id", "=", emailId).executeTakeFirst();
  if (!email) return null;
  const info: Record<string, string> = {};
  for (const [k, v] of Object.entries(email)) info[k] = v === null ? "" : String(v);
  for (const type of ["mailbox", "smtp"] as const) await accountInfo(executor, emailId, type, info);
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
