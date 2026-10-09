import "server-only";

import { htmlToPlain, sendMail } from "../../mail/mailer";
import { buildTicketVars, companyVar, entryVar, loadStaffInfo, staffVar } from "../../mail/objects";
import { loadMsgTemplate, templateGroupFor } from "../../mail/templates";
import { VariableReplacer } from "../../mail/variables";
import { entryAttachmentsForMail } from "../file/upload";
import { createThreadEntry, lastMessage, touchThread } from "../thread/write";
import type { WriteContext } from "./context";
import { deptEmail, loadDept } from "./create-alerts";
import { onActivity } from "./post";
import type { TicketRecord } from "./record";

/**
 * Ticket::postCannedReply($canned, $message, $alert) (include/class.ticket.php) usato dall'azione
 * di filtro "Attach Canned Response" alla creazione del ticket:
 * - risposta (tipo R) con poster "SYSTEM (Canned Reply)", staff = agente corrente o 0, senza
 *   destinatari (reply-to non impostato → getRecipients(null) = null), allegati della risposta
 *   predefinita (attachment tipo 'C');
 * - onResponse (isanswered = 1, onActivity "New Response"), poi markUnAnswered (isanswered = 0);
 * - se $alert, email `ticket.autoreply` al proprietario come auto-risposta (thread = la risposta).
 * Differenza: Format::viewableImages (immagini cid: della risposta predefinita trasformate in URL di
 * download) non è replicato: le risposte predefinite con immagini inline restano con `cid:`.
 */
export async function postCannedReply(
  ctx: WriteContext,
  rec: TicketRecord,
  threadId: number,
  cannedId: number,
  alert: boolean,
  ip: string,
): Promise<boolean> {
  const { tx, cfg, agent } = ctx;
  const canned = await tx.selectFrom("canned_response").select(["canned_id", "isenabled", "response"]).where("canned_id", "=", cannedId).executeTakeFirst();
  if (!canned || !canned.isenabled) return false;

  const atts = await tx
    .selectFrom("attachment as a")
    .innerJoin("file as f", "f.id", "a.file_id")
    .select(["a.file_id", "a.name", "f.name as fname"])
    .where("a.object_id", "=", canned.canned_id)
    .where("a.type", "=", "C")
    .orderBy("a.id")
    .execute();
  const files = atts.map((a) => ({ id: a.file_id, name: a.name || a.fname }));

  // Ticket::replaceVars → osTicket::replaceTemplateVariables (ticket, url, company)
  const tv = await buildTicketVars(tx, rec.id, cfg, ctx.dbZone);
  if (!tv) return false;
  const url = cfg.str("helpdesk_url").replace(/\/+$/, "");
  const company = await companyVar(tx);
  const replaced = new VariableReplacer().assign({ ticket: tv.ticket, url, company }).replaceVars(canned.response ?? "");
  const richtext = cfg.bool("enable_richtext");
  const body = richtext ? replaced : htmlToPlain(replaced);

  const last = await lastMessage(tx, threadId);
  const assigneeId = rec.get("staff_id");
  const entry = await createThreadEntry(tx, cfg, {
    threadId,
    type: "R",
    body,
    format: richtext ? "html" : "text",
    staffId: agent?.id ?? 0,
    userId: 0,
    poster: "SYSTEM (Canned Reply)",
    pid: last?.id,
    ip,
    files,
    editorSpacing: !!ctx.actor,
  });
  await touchThread(tx, threadId, "lastresponse");

  // onResponse
  rec.set("isanswered", 1);
  await rec.save();
  await onActivity(ctx, rec, threadId, { activity: "New Response", entry: { id: entry.id, staff_id: agent?.id ?? 0 }, assigneeId });
  // markUnAnswered
  if (rec.get("isanswered")) {
    rec.set("isanswered", 0);
    await rec.save();
  }
  if (!alert) return true;

  const dept = await loadDept(tx, rec.get("dept_id"));
  const email = dept ? await deptEmail(ctx, dept) : null;
  const tpl = email ? await loadMsgTemplate(tx, await templateGroupFor(tx, rec.get("dept_id"), cfg), "ticket.autoreply") : null;
  if (!dept || !email || !tpl) return true;
  const tv2 = await buildTicketVars(tx, rec.id, cfg, ctx.dbZone);
  if (!tv2 || !tv2.owner || !tv2.ownerVar) return true;
  const row = await tx.selectFrom("thread_entry").selectAll().where("id", "=", entry.id).executeTakeFirstOrThrow();
  const poster = agent ? await loadStaffInfo(tx, agent.id) : null;
  const r = new VariableReplacer().assign({
    response: entryVar(row, cfg, ctx.dbZone, poster ? staffVar(poster, cfg) : null),
    signature: dept.ispublic ? dept.signature : "",
    recipient: tv2.ownerVar,
    ticket: tv2.ticket,
    url,
    company,
  });
  const subject = r.replaceVars(tpl.subj);
  const mailBody = r.replaceVars(tpl.body);
  const attachments = cfg.bool("email_attachments") && files.length ? await entryAttachmentsForMail(tx, entry.id) : [];
  const to = [{ name: tv2.ownerVar.asVar(r), address: tv2.owner.email }];
  const ownerId = tv2.owner.id;
  ctx.after.push(async () => {
    await sendMail({
      email,
      to,
      subject,
      body: mailBody,
      recipient: { userId: ownerId, utype: "U" },
      thread: { entryId: entry.id, threadId },
      autoreply: true,
      attachments: attachments.length ? attachments : undefined,
    });
  });
  return true;
}
