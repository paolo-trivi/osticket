import "server-only";

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

import { convert as htmlToText } from "html-to-text";
import nodemailer from "nodemailer";
import type Mail from "nodemailer/lib/mailer";

import { coreConfig, loadConfigNamespace } from "../config/config";
import { decrypt } from "../crypto/crypto";
import { db, type DbOrTx } from "../db";
import { installConfig } from "../env";
import { logSystem } from "../system/syslog";
import { readStoredFile } from "../domain/file/storage";
import { buildMessageId, type RecipientClass } from "./message-id";

/**
 * Invio email equivalente a osTicket\Mail\Mailer::send (include/class.mailer.php):
 * - Message-ID firmato (B<sysid>-<rand>-<tag>-<email di sistema>);
 * - corpo HTML preceduto dal div nascosto `mid-<Message-ID>` con il separatore di risposta;
 * - alternativa testuale con `Ref-Mid:`; header X-Mailer, Return-Path, In-Reply-To/References;
 * - trasporto: account SMTP attivo dell'email di sistema o del MTA predefinito, altrimenti sendmail
 *   (come mail() di PHP). In sviluppo OST_SENDMAIL_PATH/OST_SMTP_URL puntano a Mailpit.
 */
export interface MailContact {
  name: string;
  address: string;
}

export interface SystemEmail {
  email_id: number;
  email: string;
  name: string;
}

export interface OutgoingMail {
  /** email di sistema da cui si invia (Email::send); null → nessuna (firma '@osTicketMailer') */
  email: SystemEmail | null;
  fromName?: string;
  to: MailContact[];
  cc?: MailContact[];
  bcc?: MailContact[];
  subject: string;
  body: string;
  /** destinatario per il tag del Message-ID */
  recipient: { userId: number; utype: RecipientClass };
  /** thread entry di riferimento (opzione 'thread' del PHP) */
  thread?: { entryId: number; threadId: number; inReplyTo?: string | null; references?: string | null };
  notice?: boolean;
  autoreply?: boolean;
  bulk?: boolean;
  attachments?: Mail.Attachment[];
  /** opzione 'text' del PHP (es. osTicket::alertAdmin): messaggio solo testo */
  text?: boolean;
}

export async function loadSystemEmail(emailId: number, executor: DbOrTx = db()): Promise<SystemEmail | null> {
  if (!emailId) return null;
  const row = await executor.selectFrom("email").select(["email_id", "email", "name"]).where("email_id", "=", emailId).executeTakeFirst();
  return row ?? null;
}

/** Testo alternativo (Format::html2text, larghezza 90). */
export function htmlToPlain(html: string): string {
  return htmlToText(html, {
    wordwrap: 90,
    selectors: [
      { selector: "a", options: { hideLinkHrefIfSameAsText: true } },
      { selector: "img", format: "skip" },
      { selector: "h1", options: { uppercase: false } },
      { selector: "h2", options: { uppercase: false } },
      { selector: "h3", options: { uppercase: false } },
      { selector: "h4", options: { uppercase: false } },
    ],
  });
}

/**
 * Invio come mail() di PHP: messaggio MIME completo su stdin del comando sendmail_path
 * (OST_SENDMAIL_PATH, default "/usr/sbin/sendmail -t -i"); in alternativa OST_SMTP_URL.
 */
async function deliverLocal(message: Mail.Options, envelopeFrom: string): Promise<void> {
  const smtpUrl = process.env.OST_SMTP_URL;
  if (smtpUrl) {
    await nodemailer.createTransport(smtpUrl).sendMail(message);
    return;
  }
  const built = await nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "unix" }).sendMail(message);
  const raw = built.message as Buffer;
  const cmd = (process.env.OST_SENDMAIL_PATH ?? "/usr/sbin/sendmail -t -i").trim().split(/\s+/);
  await new Promise<void>((resolve, reject) => {
    // -f: mittente della busta (Return-Path), come il trasporto Sendmail di osTicket
    const args = envelopeFrom ? [...cmd.slice(1), "-f", envelopeFrom] : cmd.slice(1);
    const child = spawn(cmd[0], args, { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`Sendmail exited with code ${code}${err ? `: ${err.trim()}` : ""}`))));
    child.stdin.end(raw);
  });
}

interface SmtpAccount {
  id: number;
  email_id: number;
  host: string;
  port: number;
  encryption: string;
  auth_bk: string;
  allow_spoofing: number | null;
  address: string;
  name: string;
}

/** Account SMTP da provare, nell'ordine del costruttore di Mailer: quello dell'email, poi il MTA predefinito. */
async function smtpAccountsFor(email: SystemEmail | null, executor: DbOrTx): Promise<SmtpAccount[]> {
  const cfg = await coreConfig();
  const base = () =>
    executor
      .selectFrom("email_account as a")
      .innerJoin("email as e", "e.email_id", "a.email_id")
      .select(["a.id", "a.email_id", "a.host", "a.port", "a.encryption", "a.auth_bk", "a.allow_spoofing", "a.active", "e.email as address", "e.name"])
      .where("a.type", "=", "smtp");
  const out: SmtpAccount[] = [];
  const push = (r: (SmtpAccount & { active: number }) | undefined) => {
    if (r && r.active && !out.some((o) => o.id === r.id)) out.push(r);
  };
  if (email) push(await base().where("a.email_id", "=", email.email_id).executeTakeFirst());
  const def = cfg.int("default_smtp_id");
  if (def) push(await base().where("a.id", "=", def).executeTakeFirst());
  return out;
}

/** Credenziali come EmailAccount::getCredentials (basic, none, mailbox); OAuth2 non è gestito da Next. */
async function smtpCredentials(acc: SmtpAccount, executor: DbOrTx): Promise<{ user: string; pass: string } | null | false> {
  const [type] = acc.auth_bk.split(":");
  let ns = `email.${acc.email_id}.account.${acc.id}`;
  if (type === "none") return null;
  if (type === "mailbox") {
    const mb = await executor
      .selectFrom("email_account")
      .select(["id", "auth_bk"])
      .where("email_id", "=", acc.email_id)
      .where("type", "=", "mailbox")
      .executeTakeFirst();
    if (!mb || !mb.auth_bk.startsWith("basic")) return false;
    ns = `email.${acc.email_id}.account.${mb.id}`;
  } else if (type !== "basic") {
    return false;
  }
  const conf = await loadConfigNamespace(ns, executor);
  const user = conf.str("username");
  const pass = decrypt(conf.str("passwd"), installConfig().secretSalt, createHash("md5").update(user + ns, "utf8").digest("hex"));
  if (!user || pass === false) return false;
  return { user, pass };
}

export async function sendMail(m: OutgoingMail, executor: DbOrTx = db()): Promise<string | false> {
  const cfg = await coreConfig();
  const { secretSalt } = installConfig();
  const messageId = buildMessageId({
    secretSalt,
    fromAddress: m.email?.email ?? null,
    recipientUserId: m.recipient.userId,
    entryId: m.thread?.entryId ?? 0,
    threadId: m.thread?.threadId ?? 0,
    utype: m.recipient.utype,
  });
  const subject = m.subject.trim().replace(/(\r\n|\r|\n)/g, "");
  const fromName = m.fromName || m.email?.name || "";
  const fromAddress = m.email?.email ?? installConfig().adminEmail;

  const headers: Record<string, string> = { "X-Mailer": "osTicket Mailer" };
  if (m.bulk) headers.Precedence = "bulk";
  if (m.autoreply) {
    Object.assign(headers, {
      Precedence: "auto_reply",
      "X-Autoreply": "yes",
      "X-Auto-Response-Suppress": "DR, RN, OOF, AutoReply",
      "Auto-Submitted": "auto-replied",
    });
  }
  if (m.notice) {
    headers["X-Auto-Response-Suppress"] ??= "OOF, AutoReply";
    headers["Auto-Submitted"] ??= "auto-generated";
  }

  let body = m.body;
  let midToken = "";
  let replyTag = "";
  // Il PHP aggiunge token e separatore solo se l'opzione 'thread' è una ThreadEntry (id > 0), non un Thread
  if (m.thread && m.thread.entryId && !m.text) {
    midToken = messageId;
    replyTag = cfg.bool("strip_quoted_reply") ? `${cfg.str("reply_separator")}<br/><br/>` : "";
  }
  if (replyTag || midToken) {
    body = `<div style="display:none"\n                        class="mid-${midToken}">${replyTag}</div>${body}`;
  }
  // opzione 'text' del PHP: corpo solo testo, senza parte HTML né Ref-Mid
  const text = m.text ? body : `${htmlToPlain(body).replace(/\s+$/, "")}\nRef-Mid: ${messageId}\n`;

  // cid:<chiave file> → immagine inline con content-id "<chiave>@<dominio mittente>" (come il PHP)
  const inline: Mail.Attachment[] = [];
  if (cfg.bool("enable_richtext")) {
    const domain = /(@[0-9a-zA-Z\-.]+)/.exec(fromAddress)?.[1] ?? "@localhost";
    const keys = [...new Set([...body.matchAll(/cid:([\w.-]{32})/g)].map((m) => m[1]))];
    for (const key of keys) {
      const f = await executor.selectFrom("file").select(["id"]).where("key", "=", key).executeTakeFirst();
      const stored = f ? await readStoredFile(f.id, executor) : null;
      if (!stored) continue;
      inline.push({ cid: `${key}${domain}`, filename: stored.name, content: stored.data, contentType: stored.type, contentDisposition: "inline" });
      body = body.split(`cid:${key}`).join(`cid:${key}${domain}`);
    }
  }

  const message: Mail.Options = {
    messageId: `<${messageId}>`,
    from: { name: fromName, address: fromAddress },
    to: m.to,
    cc: m.cc?.length ? m.cc : undefined,
    bcc: m.bcc?.length ? m.bcc : undefined,
    subject,
    text,
    html: !m.text && cfg.bool("enable_richtext") ? body : undefined,
    headers,
    inReplyTo: m.thread?.inReplyTo || undefined,
    references: m.thread?.references || undefined,
    attachments: [...inline, ...(m.attachments ?? [])],
    envelope: { from: m.email?.email ?? fromAddress, to: [...m.to, ...(m.cc ?? []), ...(m.bcc ?? [])].map((c) => c.address) },
  };

  // Account SMTP in ordine; un errore viene registrato e si passa al successivo, poi a sendmail.
  for (const acc of await smtpAccountsFor(m.email, executor)) {
    try {
      const creds = await smtpCredentials(acc, executor);
      if (creds === false) throw new Error(`Credentials: ${acc.auth_bk}: credenziali non disponibili`);
      const transport = nodemailer.createTransport({
        host: acc.host,
        port: acc.port,
        secure: acc.encryption === "SSL",
        ignoreTLS: acc.encryption === "NONE",
        auth: creds ? { user: creds.user, pass: creds.pass } : undefined,
      });
      const msg: Mail.Options = { ...message };
      // Senza spoofing il mittente effettivo è l'account SMTP (Sender), il From resta quello richiesto
      if (!acc.allow_spoofing && acc.address.toLowerCase() !== fromAddress.toLowerCase()) {
        msg.sender = { name: fromName || acc.name || acc.address, address: acc.address };
        msg.envelope = { ...message.envelope, from: acc.address } as Mail.Options["envelope"];
      }
      await transport.sendMail(msg);
      return messageId;
    } catch (ex) {
      await logSystem("Error", "Mailer Error", `Unable to email via SMTP: ${acc.address} (${acc.host}:${acc.port})\n\n${(ex as Error).message}\n`, "", { executor });
    }
  }

  try {
    await deliverLocal(message, m.email?.email ?? "");
    return messageId;
  } catch (ex) {
    await logSystem("Error", "Mailer Error", `Unable to email via Sendmail\n\n${(ex as Error).message}\n`, "", { executor });
    return false;
  }
}
