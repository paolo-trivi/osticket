import "server-only";

import { ThreadEntryType } from "@/lib/osticket/object-types";

import { phpTrim, sanitizeText, editorSpacing, stripEmptyLines } from "../../format/text";
import type { SystemEmail } from "../../mail/mailer";
import { buildTicketVars, companyVar, entryVar } from "../../mail/objects";
import { loadMsgTemplate, templateGroupFor } from "../../mail/templates";
import type { AttachInput } from "../file/upload";
import { deptAlertEmail, replaceAlertVars, sendStaffAlerts, teamAlertMembers } from "../staff-alerts";
import { ticketThreadId } from "../thread/ids";
import { createThreadEntry, touchThread, type EntryRecipients } from "../thread/write";
import { addTicketCollaborator } from "./collaborators";
import type { WriteContext } from "./context";
import { mergeTypeOf } from "./merge-flags";
import { SQL_NOW, TicketRecord } from "./record";
import { loadStatus, ticketIsReopenable } from "./status";
import { reopenTicket } from "./ticket-state";
import { notifyCollaborators, recipientsAll, recipientsJson, sendMessageAutoresponse, type DeptRow } from "./message-mail";

/**
 * Ticket::postMessage (include/class.ticket.php:3081) per i messaggi dal portale clienti (origine Web)
 * con onMessage, notifyCollaborators e gli avvisi agli agenti (message.alert). Righe come il PHP:
 *  - eventuale collaboratore (poster diverso dal proprietario: Thread::addCollaborator, evento collab);
 *  - thread_entry M (destinatari = tutti tranne il poster, flag), _search H, allegati;
 *  - thread.lastmessage = NOW(); ticket isanswered = 0, lastupdate = NOW(), updated = NOW();
 *  - riapertura se chiuso e riapribile (Ticket::reopen → setStatus: evento reopened, est_duedate…).
 * Email (dopo il commit): message.autoresp al poster, ticket.activity.notice ai partecipanti,
 * message.alert agli agenti. Destinatari, auto-risposta e notifyCollaborators sono in ./message-mail.
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
    type: ThreadEntryType.MESSAGE,
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
  if (autorespond && dept) await sendMessageAutoresponse(ctx, rec, dept, { posterId: input.userId, threadId, entryId: entry.id, tplGroup, deptEmail, company, url });

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
