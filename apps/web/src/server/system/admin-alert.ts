import "server-only";

import type { ConfigNamespace } from "../config/config";
import { db, type DbOrTx } from "../db";
import { installConfig } from "../env";
import { loadSystemEmail, type OutgoingMail } from "../mail/mailer";
import { logSystem, shouldAlertAdmin, type LogLevel } from "./syslog";

/**
 * osTicket::alertAdmin($subject, $message) (include/class.osticket.php): email di solo testo
 * all'amministratore (admin_email, altrimenti ADMIN_EMAIL dell'installazione) dall'email di avviso
 * (alert_email_id, altrimenti default_email_id), con l'URL dell'helpdesk in coda; opzioni
 * text=true e reply-tag=false, destinatario stringa → classe '?' nel Message-ID.
 * Restituisce la mail da inviare: il chiamante la mette in `ctx.after` (dopo il commit).
 */
export async function adminAlertMail(cfg: ConfigNamespace, subject: string, message: string, executor: DbOrTx = db()): Promise<OutgoingMail> {
  const to = cfg.str("admin_email") || installConfig().adminEmail;
  const body = `${message}\n\n${cfg.str("helpdesk_url").replace(/\/+$/, "")}`;
  const email = (await loadSystemEmail(cfg.int("alert_email_id"), executor)) ?? (await loadSystemEmail(cfg.int("default_email_id"), executor));
  return { email, to: [{ name: "", address: to }], subject, body, recipient: { userId: 0, utype: "?" }, notice: true, text: true };
}

/**
 * osTicket::log($priority, $title, $message, $alert=true): riga syslog e, se il livello di log lo
 * consente, avviso all'amministratore (logWarning/logError con $alert predefinito a true).
 * Restituisce la mail di avviso da inviare dopo il commit, o null.
 */
export async function logWithAdminAlert(
  cfg: ConfigNamespace,
  level: LogLevel,
  title: string,
  message: string,
  ip: string,
  executor: DbOrTx = db(),
): Promise<OutgoingMail | null> {
  if (!(await logSystem(level, title, message, ip, { executor }))) return null;
  if (!shouldAlertAdmin(cfg.int("log_level"), level)) return null;
  return adminAlertMail(cfg, title, message, executor);
}
