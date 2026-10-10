import "server-only";

import { Collaborator } from "@/lib/osticket/flags";

import type { DbOrTx } from "../../db";
import { loadSystemEmail, type MailContact, type SystemEmail, sendMail } from "../../mail/mailer";
import { buildTicketVars, contactVar, formAnswerMap, loadUserContact, userPersonsName } from "../../mail/objects";
import { loadMsgTemplate } from "../../mail/templates";
import { VarBag, VariableReplacer, type TemplateVariable } from "../../mail/variables";
import { entryAttachmentsForMail } from "../file/upload";
import { lastMessage, type EntryRecipients } from "../thread/write";
import type { WriteContext } from "./context";
import type { TicketRecord } from "./record";

/**
 * Destinatari ed email dei messaggi del portale: partecipanti del thread (Ticket::getRecipients), intestazioni
 * di threading, auto-risposta al poster (parte email di Ticket::onMessage) e Ticket::notifyCollaborators.
 */

interface Contact {
  kind: "owner" | "collab";
  listId: number;
  userId: number;
  name: string;
  email: string;
}

/** Ticket::getRecipients('all'): proprietario (to) e collaboratori attivi (cc) */
export async function recipientsAll(ctx: WriteContext, ownerId: number, threadId: number): Promise<Contact[]> {
  const out: Contact[] = [];
  const owner = await loadUserContact(ctx.tx, ownerId);
  if (owner) out.push({ kind: "owner", listId: owner.id, userId: owner.id, name: userPersonsName(owner, ctx.cfg).toString(), email: owner.email });
  // Thread::getCollaborators: ordinati per nome dell'utente
  const collabs = await ctx.tx
    .selectFrom("thread_collaborator as c")
    .innerJoin("user as u", "u.id", "c.user_id")
    .select(["c.id", "c.user_id", "c.flags"])
    .where("c.thread_id", "=", threadId)
    .orderBy("u.name")
    .orderBy("c.id")
    .execute();
  for (const c of collabs) {
    if (!(c.flags & Collaborator.ACTIVE)) continue;
    const u = await loadUserContact(ctx.tx, c.user_id);
    if (u) out.push({ kind: "collab", listId: c.id, userId: c.user_id, name: userPersonsName(u, ctx.cfg).toString(), email: u.email });
  }
  return out;
}

/** MailingList::getEmailAddresses: liste ordinate come il PHP (proprietario in to, collaboratori in cc) */
export function recipientsJson(list: Contact[]): EntryRecipients {
  const out: EntryRecipients = {};
  for (const k of ["to", "cc"] as const) {
    const items = list.filter((c) => (c.kind === "owner" ? "to" : "cc") === k);
    if (items.length) out[k] = items.map((c): [string, string] => [String(c.listId), `${c.name} <${c.email}>`]);
  }
  return out;
}

/** In-Reply-To/References dall'ultimo messaggio arrivato via email (Mailer::send senza 'inreplyto') */
async function emailThreading(executor: DbOrTx, threadId: number, userId?: number): Promise<{ inReplyTo: string | null; references: string | null }> {
  const last = await lastMessage(executor, threadId, { emailOnly: true, ...(userId ? { userId } : {}) });
  if (!last?.mid) return { inReplyTo: null, references: null };
  const refHeader = /^References:\s*((?:.*(?:\r?\n[ \t]+.*)*))/im.exec(last.headers ?? "")?.[1]?.replace(/\r?\n[ \t]+/g, " ").trim();
  return { inReplyTo: last.mid, references: `${refHeader ? `${refHeader} ` : ""}${last.mid}` };
}

export interface DeptRow {
  id: number;
  email_id: number;
  autoresp_email_id: number;
  manager_id: number | null;
  ispublic: number;
  signature: string | null;
  message_auto_response: number;
}

/** Ticket::onMessage: auto-risposta message.autoresp al poster (proprietario o collaboratore). */
export async function sendMessageAutoresponse(
  ctx: WriteContext,
  rec: TicketRecord,
  dept: DeptRow,
  deps: { posterId: number; threadId: number; entryId: number; tplGroup: number; deptEmail: () => Promise<SystemEmail | null>; company: TemplateVariable; url: string },
): Promise<void> {
  const { tx, cfg } = ctx;
  const isOwner = rec.get("user_id") === deps.posterId;
  const collab = isOwner
    ? null
    : await tx.selectFrom("thread_collaborator").select(["id", "user_id"]).where("thread_id", "=", deps.threadId).where("user_id", "=", deps.posterId).executeTakeFirst();
  const contact = isOwner || collab ? await loadUserContact(tx, deps.posterId) : null;
  // Email::getIdByEmail($user->getEmail()) riceve '"Nome" <indirizzo>' e non trova mai un'email di
  // sistema: il controllo anti-loop del PHP non scatta mai (stranezza replicata)
  if (contact && dept.message_auto_response && cfg.bool("message_autoresponder")) {
    const email = (await loadSystemEmail(dept.autoresp_email_id, tx)) ?? (await deps.deptEmail());
    const tpl = email ? await loadMsgTemplate(tx, deps.tplGroup, "message.autoresp") : null;
    const tv = tpl ? await buildTicketVars(tx, rec.id, cfg, ctx.dbZone) : null;
    if (email && tpl && tv) {
      const recipient = isOwner ? tv.ownerVar : collaboratorVar(contact, cfg, rec.id, tv.numCollaborators, deps.url);
      const r = new VariableReplacer().assign({
        recipient,
        signature: dept.ispublic ? (dept.signature ?? "") : "",
        ticket: tv.ticket,
        url: deps.url,
        company: deps.company,
      });
      const subject = r.replaceVars(tpl.subj);
      const htmlBody = r.replaceVars(tpl.body);
      const to: MailContact = { name: userPersonsName(contact, cfg).toString(), address: contact.email };
      const threading = await emailThreading(tx, deps.threadId, contact.id);
      const utype = isOwner ? "U" : "C";
      ctx.after.push(async () => {
        // Mailer::send: TicketOwner in To, Collaborator in Cc
        await sendMail({
          email,
          to: isOwner ? [to] : [],
          cc: isOwner ? [] : [to],
          subject,
          body: htmlBody,
          recipient: { userId: contact.id, utype },
          thread: { entryId: deps.entryId, threadId: deps.threadId, ...threading },
          autoreply: true,
        });
      });
    }
  }
}

/**
 * Collaborator come variabile di template: nome (getName), email e `ticket_link` di
 * Collaborator::getVar (token solo se il ticket non ha collaboratori, quindi in pratica sempre
 * tickets.php?id=<id>).
 */
function collaboratorVar(u: { id: number; name: string; email: string; org_name: string | null }, cfg: WriteContext["cfg"], ticketId: number, numCollaborators: number, url: string): TemplateVariable {
  const name = userPersonsName(u, cfg);
  return new VarBag({ name, email: u.email, id: u.id, ticket_link: numCollaborators ? `${url}/tickets.php?id=${ticketId}` : `${url}/view.php?id=${ticketId}` }, () => name.toString());
}

/**
 * Ticket::notifyCollaborators($entry): una sola email (MailingList: proprietario in To, collaboratori
 * in Cc) a tutti i partecipanti attivi tranne il poster, con il template ticket.activity.notice. Se il
 * proprietario non è tra i destinatari il saluto è "Collaborator" e `recipient` è l'ultimo contatto
 * esaminato (stranezza del PHP replicata).
 */
export async function notifyCollaborators(
  ctx: WriteContext,
  rec: TicketRecord,
  threadId: number,
  entryId: number,
  posterId: number,
  deps: { tplGroup: number; deptEmail: () => Promise<SystemEmail | null>; company: TemplateVariable; url: string; message: string },
): Promise<void> {
  const { tx, cfg } = ctx;
  const all = await recipientsAll(ctx, rec.get("user_id"), threadId);
  if (!all.length) return;
  const tpl = await loadMsgTemplate(tx, deps.tplGroup, "ticket.activity.notice");
  const email = await deps.deptEmail();
  if (!tpl || !email) return;
  const poster = await loadUserContact(tx, posterId);
  if (!poster) return;
  const tv = await buildTicketVars(tx, rec.id, cfg, ctx.dbZone);
  if (!tv) return;
  const posterAnswers = await formAnswerMap(tx, "U", poster.id);
  const posterVar = contactVar(poster, cfg, null, { isOwner: false, contactId: poster.id, numCollaborators: 0, answers: posterAnswers });
  const first = new VariableReplacer().assign({ message: deps.message, poster: posterVar, ticket: tv.ticket, url: deps.url, company: deps.company });
  const msg = { subj: first.replaceVars(tpl.subj), body: first.replaceVars(tpl.body) };

  const recipients = all.filter((c) => c.userId !== posterId);
  if (!recipients.length) return;
  const owner = all.find((c) => c.kind === "owner");
  const last = all[all.length - 1];
  let notice: { subj: string; body: string };
  if (owner && owner.email !== poster.email) {
    const r = new VariableReplacer().assign({ recipient: tv.ownerVar, ticket: tv.ticket, url: deps.url, company: deps.company });
    notice = { subj: r.replaceVars(msg.subj), body: r.replaceVars(msg.body) };
  } else {
    const names: Record<string, unknown> = {};
    for (const f of ["first", "last", "full", "legal", "lastfirst", "formal", "short", "shortformal", "complete", "original"]) names[`recipient.name.${f}`] = "Collaborator";
    const lastContact = await loadUserContact(tx, last.userId);
    const lastVar = lastContact
      ? last.kind === "owner"
        ? tv.ownerVar
        : collaboratorVar(lastContact, cfg, rec.id, tv.numCollaborators, deps.url)
      : null;
    const r = new VariableReplacer().assign({ ...names, recipient: lastVar, ticket: tv.ticket, url: deps.url, company: deps.company });
    notice = { subj: r.replaceVars(msg.subj), body: r.replaceVars(msg.body) };
  }
  const attachments = cfg.bool("email_attachments") ? await entryAttachmentsForMail(tx, entryId) : [];
  const threading = await emailThreading(tx, threadId);
  const to = recipients.filter((c) => c.kind === "owner").map((c) => ({ name: c.name, address: c.email }));
  const cc = recipients.filter((c) => c.kind === "collab").map((c) => ({ name: c.name, address: c.email }));
  ctx.after.push(async () => {
    await sendMail({
      email,
      to,
      cc,
      subject: notice.subj,
      body: notice.body,
      recipient: { userId: 0, utype: "M" },
      thread: { entryId, threadId, ...threading },
      attachments: attachments.length ? attachments : undefined,
    });
  });
}
