import "server-only";

import type { MailContact } from "../../mail/mailer";
import { truthy as phpTruthy, type PhpVal } from "../../php/values";
import type { AttachInput } from "../file/upload";
import { isEmail } from "../forms/validator";
import { TicketPerm } from "../staff/staff";
import { deleteDraftsFor } from "./collab";
import type { WriteContext } from "./context";
import { createTicket, TICKET_SOURCES, type CreateErrors, type CreateOptions, type CreateResult, type CreateTicketVars } from "./create";
import { sendNewTicketNotice } from "./create-alerts";
import { ticketRecipients } from "./create-collab";
import { postNote, postReply } from "./post";
import { TicketRecord } from "./record";
import { stateOf } from "./status";

/**
 * Apertura di un ticket dal pannello agenti (Ticket::open, scp/tickets.php a=open): permessi di
 * creazione e assegnazione, poi Ticket::create, risposta iniziale, nota interna e notifica `ticket.notice`.
 */

/** (bool) di PHP sui $vars (valori ignoti trattati come PhpVal) */
const truthy = (v: unknown) => phpTruthy(v as PhpVal);

interface OpenTicketInput extends CreateTicketVars {
  /** risposta iniziale (opzionale) */
  response?: string;
  /** nota interna (opzionale; commenti dell'assegnazione se c'è assignId) */
  note?: string;
  /** notifica: all | user | none */
  "reply-to"?: string;
  signature?: "none" | "mine" | "dept";
  /** s<id> | t<id> */
  assignId?: string;
  /** allegati della risposta iniziale */
  responseFiles?: AttachInput[];
}

/**
 * Ticket::open($vars, $errors): apertura da agente con controlli dei permessi, risposta iniziale,
 * nota interna e notifica `ticket.notice`.
 */
export async function openTicket(ctx: WriteContext, input: OpenTicketInput, opts: CreateOptions = {}): Promise<CreateResult> {
  const { tx, cfg, agent } = ctx;
  const errors: CreateErrors = {};
  if (!agent) return { ok: false, errors: { err: "forbidden" } };
  if (!agent.hasPermInAnyRole(TicketPerm.CREATE)) return { ok: false, errors: { err: "You do not have permission to create tickets" } };

  let role = null;
  if (truthy(input.deptId)) {
    const dept = await tx.selectFrom("department").select("id").where("id", "=", Number(input.deptId)).executeTakeFirst();
    if (dept) {
      role = agent.roleFor(dept.id);
      if (!role.perms.has(TicketPerm.CREATE)) return { ok: false, errors: { err: "You do not have permission to create a ticket in this department" } };
    }
  }
  if (input.source !== undefined && !(TICKET_SOURCES as readonly string[]).includes(String(input.source))) errors.source = `Invalid source given - ${String(input.source)}`;
  if (!truthy(input.uid)) {
    if (!input.email || !isEmail(String(input.email))) errors.email = "Valid email address is required";
    if (!input.name) errors.name = "Name is required";
  }
  // Regola più stretta del PHP: un ruolo "solo creazione" (reparto senza accesso) non consente l'assegnazione
  if (truthy(input.assignId) && !(role ? role.perms.has(TicketPerm.ASSIGN) : agent.hasPermInAnyRole(TicketPerm.ASSIGN))) {
    errors.assignId = "Action Denied. You are not allowed to assign/reassign tickets.";
  }

  const createVars: CreateTicketVars = { ...input };
  delete createVars.response;
  delete createVars.responseFiles;
  if (Object.keys(errors).length) return { ok: false, errors };
  const res = await createTicket(ctx, createVars, "staff", { ...opts, autorespond: false });
  if (!res.ok) return res;
  // scp/tickets.php: dopo l'apertura si eliminano le bozze dell'agente 'ticket.staff%'
  // (qui prima delle notifiche, che partono comunque dopo il commit)
  await deleteDraftsFor(tx, "ticket.staff%", agent.id);

  const rec = (await TicketRecord.load(tx, res.ticketId, true))!;
  const assigned = rec.get("staff_id") === agent.id || agent.isTeamMember(rec.get("team_id"));
  const ticketRole = agent.roleFor(rec.get("dept_id"), (await stateOf(tx, rec.row)) === "open" && assigned);
  const replyTo = String(input["reply-to"] ?? "all");
  const alert = replyTo.toLowerCase() !== "none";
  let responseId = 0;
  const responseText = String(input.response ?? "");
  if (responseText && ticketRole.perms.has(TicketPerm.REPLY)) {
    const r = await postReply(ctx, {
      ticketId: rec.id,
      response: responseText,
      replyTo,
      ccs: Array.isArray(input.ccs) ? (input.ccs as unknown[]).map(Number) : undefined,
      signature: input.signature,
      alert: alert && !cfg.bool("ticket_notice_active"),
      files: input.responseFiles,
      source: input.source === undefined ? undefined : String(input.source),
    });
    if ("entryId" in r) responseId = r.entryId;
  }
  if (!truthy(input.assignId) && input.note) {
    await postNote(ctx, { ticketId: rec.id, note: String(input.note), title: "New Ticket", format: cfg.bool("enable_richtext") ? "html" : "text", alert: false });
  }

  if (!cfg.bool("ticket_notice_active") || !alert) return res;
  await rec.reload();
  const recipients = await ticketRecipients(ctx, rec.get("user_id"), res.threadId, replyTo);
  if (!recipients) return res;
  const contacts = (list: { name: string; email: string }[]): MailContact[] => list.map((c) => ({ name: c.name, address: c.email }));
  await sendNewTicketNotice(
    ctx,
    { ticketId: rec.id, threadId: res.threadId, deptId: rec.get("dept_id"), messageId: res.messageId ?? 0, responseId },
    { to: contacts(recipients.to), cc: contacts(recipients.cc) },
    String(input.signature ?? "none"),
  );
  return res;
}
