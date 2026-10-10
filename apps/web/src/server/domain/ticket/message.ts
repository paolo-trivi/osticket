import "server-only";

import { type DbOrTx } from "../../db";
import { phpTrim, sanitizeText, editorSpacing, stripEmptyLines } from "../../format/text";
import { loadSystemEmail, type MailContact, type SystemEmail, sendMail } from "../../mail/mailer";
import { buildTicketVars, companyVar, contactVar, entryVar, formAnswerMap, loadUserContact, userPersonsName } from "../../mail/objects";
import { loadMsgTemplate, templateGroupFor } from "../../mail/templates";
import { VarBag, VariableReplacer, type TemplateVariable } from "../../mail/variables";
import { entryAttachmentsForMail, type AttachInput } from "../file/upload";
import { deptAlertEmail, replaceAlertVars, sendStaffAlerts, teamAlertMembers } from "../staff-alerts";
import { createThreadEntry, lastMessage, touchThread, type EntryRecipients } from "../thread/write";
import { addTicketCollaborator } from "./collaborators";
import type { WriteContext } from "./context";
import { mergeTypeOf } from "./merge-flags";
import { ticketThreadId } from "./post";
import { SQL_NOW, TicketRecord } from "./record";
import { loadStatus, ticketIsReopenable } from "./status";
import { reopenTicket } from "./ticket-state";

/**
 * Ticket::postMessage (include/class.ticket.php:3081) per i messaggi dal portale clienti (origine Web)
 * con onMessage, notifyCollaborators e gli avvisi agli agenti (message.alert). Righe come il PHP:
 *  - eventuale collaboratore (poster diverso dal proprietario: Thread::addCollaborator, evento collab);
 *  - thread_entry M (destinatari = tutti tranne il poster, flag), _search H, allegati;
 *  - thread.lastmessage = NOW(); ticket isanswered = 0, lastupdate = NOW(), updated = NOW();
 *  - riapertura se chiuso e riapribile (Ticket::reopen → setStatus: evento reopened, est_duedate…).
 * Email (dopo il commit): message.autoresp al poster, ticket.activity.notice ai partecipanti,
 * message.alert agli agenti.
 */
interface PostMessageInput {
  ticketId: number;
  /** $thisclient->getId() */
  userId: number;
  /** (string) $thisclient->getName() */
  poster: string;
  /** corpo come inviato dal form (tickets.php lo pulisce con ThreadEntryBody::clean) */
  message: string;
  files?: AttachInput[];
  origin?: string;
  alerts?: boolean;
}

export type PostMessageResult = { entryId: number; ticketId: number } | { error: "not_found" | "message_required" };

interface Contact {
  kind: "owner" | "collab";
  listId: number;
  userId: number;
  name: string;
  email: string;
}

/** Ticket::getRecipients('all'): proprietario (to) e collaboratori attivi (cc) */
async function recipientsAll(ctx: WriteContext, ownerId: number, threadId: number): Promise<Contact[]> {
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
    if (!(c.flags & 1)) continue;
    const u = await loadUserContact(ctx.tx, c.user_id);
    if (u) out.push({ kind: "collab", listId: c.id, userId: c.user_id, name: userPersonsName(u, ctx.cfg).toString(), email: u.email });
  }
  return out;
}

/** MailingList::getEmailAddresses: liste ordinate come il PHP (proprietario in to, collaboratori in cc) */
function recipientsJson(list: Contact[]): EntryRecipients {
  const out: EntryRecipients = {};
  for (const k of ["to", "cc"] as const) {
    const items = list.filter((c) => (c.kind === "owner" ? "to" : "cc") === k);
    if (items.length) out[k] = items.map((c): [string, string] => [String(c.listId), `${c.name} <${c.email}>`]);
  }
  return out;
}

/**
 * ThreadEntryBody::clean($text) di tickets.php: getClean senza le trasformazioni di ThreadEntry::create,
 * che poi pulisce di nuovo il corpo (doppia pulizia del PHP). Per il testo semplice la seconda
 * Format::htmlchars non ricodifica le entità (double_encode = false): basta la pulizia di createThreadEntry.
 */
function preClean(body: string, format: "html" | "text"): string {
  if (format === "html") {
    const b = phpTrim(body, " <>br/\t\n\r") ? body : "";
    return sanitizeText(editorSpacing(b));
  }
  return stripEmptyLines(body.trim() ? body : "");
}

/** In-Reply-To/References dall'ultimo messaggio arrivato via email (Mailer::send senza 'inreplyto') */
async function emailThreading(executor: DbOrTx, threadId: number, userId?: number): Promise<{ inReplyTo: string | null; references: string | null }> {
  const last = await lastMessage(executor, threadId, { emailOnly: true, ...(userId ? { userId } : {}) });
  if (!last?.mid) return { inReplyTo: null, references: null };
  const refHeader = /^References:\s*((?:.*(?:\r?\n[ \t]+.*)*))/im.exec(last.headers ?? "")?.[1]?.replace(/\r?\n[ \t]+/g, " ").trim();
  return { inReplyTo: last.mid, references: `${refHeader ? `${refHeader} ` : ""}${last.mid}` };
}

interface DeptRow {
  id: number;
  email_id: number;
  autoresp_email_id: number;
  manager_id: number | null;
  ispublic: number;
  signature: string | null;
  message_auto_response: number;
}

export async function postMessage(ctx: WriteContext, input: PostMessageInput): Promise<PostMessageResult> {
  const { tx, cfg } = ctx;
  const origin = input.origin ?? "Web";
  const alerts = input.alerts ?? true;
  const self = await TicketRecord.load(tx, input.ticketId, true);
  if (!self) return { error: "not_found" };
  // Messaggio di un ticket figlio (merge non "visual"): va al ticket padre
  let rec = self;
  if (self.get("ticket_pid") && mergeTypeOf(self.get("flags")) !== "visual") {
    const parent = await TicketRecord.load(tx, Number(self.get("ticket_pid")), true);
    if (parent) rec = parent;
  }
  const format = cfg.bool("enable_richtext") ? "html" : "text";
  const body = preClean(input.message ?? "", format);
  if (!body) return { error: "message_required" };
  const threadId = await ticketThreadId(tx, rec.id);

  // Poster diverso dal proprietario: Thread::addCollaborator (se non lo è già), evento collab
  if (input.userId && input.userId !== rec.get("user_id")) {
    const exists = await tx.selectFrom("thread_collaborator").select("id").where("thread_id", "=", threadId).where("user_id", "=", input.userId).executeTakeFirst();
    if (!exists) await addTicketCollaborator(ctx, rec.row, threadId, input.userId, true);
  }

  // Destinatari attivi tranne il poster (messaggi dal portale)
  let recipients: EntryRecipients | undefined;
  if (origin.toLowerCase() !== "email") {
    const json = recipientsJson((await recipientsAll(ctx, rec.get("user_id"), threadId)).filter((c) => c.userId !== input.userId));
    if (Object.keys(json).length) recipients = json;
  }

  const entry = await createThreadEntry(tx, cfg, {
    threadId,
    type: "M",
    body,
    format,
    staffId: 0,
    userId: input.userId,
    poster: input.poster,
    ip: ctx.actor?.ip ?? "",
    recipients,
    files: input.files?.length ? input.files : undefined,
    editorSpacing: true,
  });
  // Thread::addMessage
  await touchThread(tx, threadId, "lastmessage");

  // Ticket::onMessage: non risposto, ultima attività, riapertura se chiuso e riapribile
  rec.set("isanswered", 0);
  rec.set("lastupdate", SQL_NOW as never);
  await rec.save();
  const status = await loadStatus(tx, rec.get("status_id"));
  if (status?.state === "closed" && (await ticketIsReopenable(tx, rec.row, status))) await reopenTicket(ctx, rec, threadId);

  const autorespond = alerts;
  const dept = (await tx
    .selectFrom("department")
    .select(["id", "email_id", "autoresp_email_id", "manager_id", "ispublic", "signature", "message_auto_response"])
    .where("id", "=", rec.get("dept_id"))
    .executeTakeFirst()) as DeptRow | undefined;
  const tplGroup = await templateGroupFor(tx, rec.get("dept_id"), cfg);
  const company = await companyVar(tx);
  const url = cfg.str("helpdesk_url").replace(/\/+$/, "");
  const deptEmail = (): Promise<SystemEmail | null> => deptAlertEmail(tx, cfg, dept?.email_id);

  const entryRow = await tx.selectFrom("thread_entry").selectAll().where("id", "=", entry.id).executeTakeFirstOrThrow();
  const messageVar = entryVar(entryRow, cfg, ctx.dbZone, null);

  // --- onMessage: auto-risposta message.autoresp al poster (proprietario o collaboratore)
  if (autorespond && dept) {
    const isOwner = rec.get("user_id") === input.userId;
    const collab = isOwner
      ? null
      : await tx.selectFrom("thread_collaborator").select(["id", "user_id"]).where("thread_id", "=", threadId).where("user_id", "=", input.userId).executeTakeFirst();
    const contact = isOwner || collab ? await loadUserContact(tx, input.userId) : null;
    // Email::getIdByEmail($user->getEmail()) riceve '"Nome" <indirizzo>' e non trova mai un'email di
    // sistema: il controllo anti-loop del PHP non scatta mai (stranezza replicata)
    if (contact && dept.message_auto_response && cfg.bool("message_autoresponder")) {
      const email = (await loadSystemEmail(dept.autoresp_email_id, tx)) ?? (await deptEmail());
      const tpl = email ? await loadMsgTemplate(tx, tplGroup, "message.autoresp") : null;
      const tv = tpl ? await buildTicketVars(tx, rec.id, cfg, ctx.dbZone) : null;
      if (email && tpl && tv) {
        const recipient = isOwner ? tv.ownerVar : collaboratorVar(contact, cfg, rec.id, tv.numCollaborators, url);
        const r = new VariableReplacer().assign({
          recipient,
          signature: dept.ispublic ? (dept.signature ?? "") : "",
          ticket: tv.ticket,
          url,
          company,
        });
        const subject = r.replaceVars(tpl.subj);
        const htmlBody = r.replaceVars(tpl.body);
        const to: MailContact = { name: userPersonsName(contact, cfg).toString(), address: contact.email };
        const threading = await emailThreading(tx, threadId, contact.id);
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
            thread: { entryId: entry.id, threadId, ...threading },
            autoreply: true,
          });
        });
      }
    }
  }

  // --- notifyCollaborators: ticket.activity.notice ai partecipanti (proprietario e collaboratori attivi)
  if (autorespond && alerts && cfg.bool("message_autoresponder_collabs") && origin.toLowerCase() !== "email") {
    await notifyCollaborators(ctx, rec, threadId, entry.id, input.userId, { tplGroup, deptEmail, company, url, message: entryRow.body });
  }

  if (!alerts || !autorespond) return { entryId: entry.id, ticketId: rec.id };

  // --- avviso message.alert agli agenti
  if (cfg.bool("message_alert_active") && dept) {
    const email = await deptEmail();
    const tpl = email ? await loadMsgTemplate(tx, tplGroup, "message.alert") : null;
    const tv = tpl ? await buildTicketVars(tx, rec.id, cfg, ctx.dbZone) : null;
    if (email && tpl && tv) {
      const vars = { ticket: tv.ticket, url, company };
      const msg = replaceAlertVars(tpl, { ...vars, message: messageVar, poster: input.poster || tv.ownerVar });
      const recipients: number[] = [];
      if (cfg.bool("message_alert_laststaff")) {
        const { lastRespondentId } = await import("./status");
        const lr = await lastRespondentId(tx, threadId);
        if (lr) recipients.push(lr);
      }
      const state = (await loadStatus(tx, rec.get("status_id")))?.state;
      if (cfg.bool("message_alert_assigned") && state === "open" && (rec.get("staff_id") || rec.get("team_id"))) {
        if (rec.get("staff_id")) recipients.push(rec.get("staff_id"));
        else recipients.push(...(await teamAlertMembers(tx, rec.get("team_id"))));
      }
      if (cfg.bool("message_alert_dept_manager") && dept.manager_id) recipients.push(dept.manager_id);
      if (cfg.bool("message_alert_acct_manager")) {
        const org = await tx
          .selectFrom("user as u")
          .innerJoin("organization as o", "o.id", "u.org_id")
          .select("o.manager")
          .where("u.id", "=", self.get("user_id"))
          .executeTakeFirst();
        const code = org?.manager ?? "";
        if (code.startsWith("s")) recipients.push(Number(code.slice(1)));
        else if (code.startsWith("t")) recipients.push(...(await teamAlertMembers(tx, Number(code.slice(1)))));
      }
      // agenti senza indirizzo esclusi (`!$staff->getEmail()`)
      await sendStaffAlerts(ctx, { email, msg, vars, recipients, skip: (staff) => !staff.email, thread: { entryId: entry.id, threadId } });
    }
  }
  // Signal object.created (type message): nessun ascoltatore nel core
  return { entryId: entry.id, ticketId: rec.id };
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
async function notifyCollaborators(
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
