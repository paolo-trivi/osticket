import "server-only";

import { FormType } from "@/lib/osticket/object-types";

import type { ConfigNamespace } from "../../config/config";
import type { DbOrTx } from "../../db";
import { stripTags } from "../../format/html";
import { PersonsName } from "../../format/persons-name";
import { loadSystemEmail, sendMail, type MailContact, type SystemEmail } from "../../mail/mailer";
import { answerToString, companyVar } from "../../mail/objects";
import { VariableReplacer, type TemplateVariable } from "../../mail/variables";

/**
 * Email basate sulle pagine di contenuto (Page::lookupByType + osTicket::replaceTemplateVariables +
 * Email::send senza opzioni): reset password e attivazione account utente, reset password e codice
 * 2FA degli agenti. Le traduzioni delle pagine (tabella translation) non sono gestite: si usano nome
 * e corpo della pagina (la tabella è vuota nelle installazioni senza lingue aggiuntive).
 */
type ContentType = "pwreset-client" | "registration-client" | "pwreset-staff" | "registration-staff" | "email2fa-staff";

export async function loadContentPage(executor: DbOrTx, type: ContentType): Promise<{ name: string; body: string } | null> {
  const row = await executor.selectFrom("content").select(["name", "body"]).where("type", "=", type).orderBy("id").executeTakeFirst();
  return row ? { name: row.name, body: row.body } : null;
}

/** User come variabile di template (User::getVar → risposte del form, poi getName()/getEmail()…). */
export async function userTemplateVar(executor: DbOrTx, userId: number, cfg: ConfigNamespace): Promise<{ v: TemplateVariable; name: string; email: string } | null> {
  const u = await executor
    .selectFrom("user as u")
    .leftJoin("user_email as e", "e.id", "u.default_email_id")
    .leftJoin("organization as o", "o.id", "u.org_id")
    .select(["u.id", "u.name", "e.address as email", "o.name as org_name"])
    .where("u.id", "=", userId)
    .executeTakeFirst();
  if (!u) return null;
  const email = u.email ?? "";
  const name = new PersonsName(u.name || email.split("@")[0], cfg.str("client_name_format"));
  const rows = await executor
    .selectFrom("form_entry as fe")
    .innerJoin("form_entry_values as v", "v.entry_id", "fe.id")
    .innerJoin("form_field as ff", "ff.id", "v.field_id")
    .select(["ff.name", "ff.type", "v.value"])
    .where("fe.object_type", "=", FormType.USER)
    .where("fe.object_id", "=", userId)
    .orderBy("fe.sort")
    .orderBy("ff.sort")
    .execute();
  const answers = new Map<string, string>();
  for (const r of rows) if (r.name && !answers.has(r.name.toLowerCase())) answers.set(r.name.toLowerCase(), answerToString(r.type ?? "text", r.value));
  const base: Record<string, unknown> = { name, email, id: u.id, organization: u.org_name ?? "", fullname: u.name };
  const v: TemplateVariable = {
    getVar(tag: string) {
      if (answers.has(tag)) return answers.get(tag);
      return base[tag];
    },
    asVar() {
      return name.toString();
    },
  };
  return { v, name: name.toString(), email };
}

/**
 * Invio come Email::send($to, striptags(subj), body) dopo replaceTemplateVariables (url, company).
 * `email` è l'email di sistema mittente.
 */
export async function sendContentMail(
  executor: DbOrTx,
  cfg: ConfigNamespace,
  opts: { email: SystemEmail; page: { name: string; body: string }; vars: Record<string, unknown>; to: MailContact },
): Promise<() => Promise<void>> {
  const r = new VariableReplacer().assign({ ...opts.vars, url: baseUrl(cfg), company: await companyVar(executor) });
  const subject = stripTags(r.replaceVars(opts.page.name));
  const body = r.replaceVars(opts.page.body);
  const email = opts.email;
  return async () => {
    await sendMail({ email, to: [opts.to], subject, body, recipient: { userId: 0, utype: "?" } });
  };
}

/** $cfg->getDefaultEmail() */
export function defaultEmail(executor: DbOrTx, cfg: ConfigNamespace): Promise<SystemEmail | null> {
  return loadSystemEmail(cfg.int("default_email_id"), executor);
}

/** $cfg->getAlertEmail() ?: $cfg->getDefaultEmail() */
export async function alertOrDefaultEmail(executor: DbOrTx, cfg: ConfigNamespace): Promise<SystemEmail | null> {
  return (await loadSystemEmail(cfg.int("alert_email_id"), executor)) ?? (await loadSystemEmail(cfg.int("default_email_id"), executor));
}


/** $cfg->getBaseUrl(): helpdesk_url senza "/" finale */
export function baseUrl(cfg: ConfigNamespace): string {
  return cfg.str("helpdesk_url").replace(/\/+$/, "");
}
