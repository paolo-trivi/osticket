import "server-only";

import { Dept, Team } from "@/lib/osticket/flags";

import type { DbOrTx } from "../../db";
import { loadSystemEmail, sendMail, type MailContact, type SystemEmail } from "../../mail/mailer";
import { buildTicketVars, companyVar, entryVar, loadStaffInfo, staffVar } from "../../mail/objects";
import { VariableReplacer, type TemplateVariable } from "../../mail/variables";
import { adminAlertMail, logWithAdminAlert } from "../../system/admin-alert";
import { entryAttachmentsForMail } from "../file/upload";
import { parseAddressList } from "../forms/validator";
import { deptAlertEmail, deptAlertMembers, deptMsgTemplate, replaceAlertVars, sendAdminAlert, sendStaffAlerts, teamAlertMembers } from "../staff-alerts";
import type { WriteContext } from "./context";

/**
 * Notifiche della creazione del ticket (include/class.ticket.php): auto-risposta `ticket.autoresp` e
 * avviso `ticket.alert` (onNewTicket), avviso di assegnazione `assigned.alert` (onAssign), notifica
 * `ticket.notice` al cliente per i ticket aperti da un agente (Ticket::open), limite di ticket aperti
 * (onOpenLimit). Le email partono dopo il commit (ctx.after).
 */

interface DeptInfo {
  id: number;
  name: string;
  email_id: number;
  autoresp_email_id: number;
  manager_id: number;
  ispublic: number;
  signature: string;
  group_membership: number;
  ticket_auto_response: number;
  flags: number;
  sla_id: number;
}

export async function loadDept(executor: DbOrTx, id: number): Promise<DeptInfo | null> {
  const d = await executor
    .selectFrom("department")
    .select(["id", "name", "email_id", "autoresp_email_id", "manager_id", "ispublic", "signature", "group_membership", "ticket_auto_response", "flags", "sla_id"])
    .where("id", "=", id)
    .executeTakeFirst();
  return d ? { ...d, signature: d.signature ?? "", manager_id: d.manager_id ?? 0 } : null;
}

/** Dept::getEmail / getAlertEmail: email del reparto o default_email_id */
export async function deptEmail(ctx: WriteContext, dept: DeptInfo): Promise<SystemEmail | null> {
  return deptAlertEmail(ctx.tx, ctx.cfg, dept.email_id);
}

/** Dept::getAutoRespEmail */
async function deptAutoRespEmail(ctx: WriteContext, dept: DeptInfo): Promise<SystemEmail | null> {
  return (await loadSystemEmail(dept.autoresp_email_id, ctx.tx)) ?? (await deptEmail(ctx, dept));
}

/** Dept::getMembersForAlerts (../staff-alerts.ts) */
function deptMembersForAlerts(ctx: WriteContext, dept: DeptInfo): Promise<number[]> {
  return deptAlertMembers(ctx.tx, dept, ctx.cfg.str("agent_name_format"));
}

async function entryTemplateVar(ctx: WriteContext, entryId: number): Promise<TemplateVariable | string> {
  if (!entryId) return "";
  const row = await ctx.tx.selectFrom("thread_entry").selectAll().where("id", "=", entryId).executeTakeFirst();
  if (!row) return "";
  const poster = row.staff_id ? await loadStaffInfo(ctx.tx, row.staff_id) : null;
  return entryVar(row, ctx.cfg, ctx.dbZone, poster ? staffVar(poster, ctx.cfg) : null);
}

function baseUrl(ctx: WriteContext): string {
  return ctx.cfg.str("helpdesk_url").replace(/\/+$/, "");
}

/** Ticket::onNewTicket($message, $autorespond, $alertstaff) */
export async function onNewTicket(
  ctx: WriteContext,
  t: { ticketId: number; threadId: number; deptId: number; messageId: number; ownerId: number },
  autorespond: boolean,
  alertstaff: boolean,
): Promise<void> {
  const { tx, cfg } = ctx;
  if (!autorespond && !alertstaff) return;
  const dept = await loadDept(tx, t.deptId);
  if (!dept) return;
  const autoEmail = await deptAutoRespEmail(ctx, dept);
  if (!autoEmail) return;
  const tv = await buildTicketVars(tx, t.ticketId, cfg, ctx.dbZone);
  if (!tv) return;
  const message = await entryTemplateVar(ctx, t.messageId);
  const company = await companyVar(tx);
  // il messaggio non arriva da email: thread = il thread del ticket (nessuna voce)
  const thread = { entryId: 0, threadId: t.threadId };

  if (autorespond && cfg.bool("ticket_autoresponder") && dept.ticket_auto_response) {
    const tpl = await deptMsgTemplate(ctx, dept.id, "ticket.autoresp");
    if (tpl && tv.ownerVar && tv.owner) {
      const r = new VariableReplacer().assign({
        message,
        recipient: tv.ownerVar,
        signature: dept.ispublic ? dept.signature : "",
        ticket: tv.ticket,
        url: baseUrl(ctx),
        company,
      });
      const subject = r.replaceVars(tpl.subj);
      const body = r.replaceVars(tpl.body);
      const to = [{ name: tv.ownerVar.asVar(r), address: tv.owner.email }];
      const ownerId = tv.owner.id;
      ctx.after.push(async () => {
        await sendMail({ email: autoEmail, to, subject, body, recipient: { userId: ownerId, utype: "U" }, thread, autoreply: true });
      });
    }
  }

  if (!alertstaff || !cfg.bool("ticket_alert_active")) return;
  const alertEmail = await deptEmail(ctx, dept);
  const tpl = await deptMsgTemplate(ctx, dept.id, "ticket.alert");
  if (!alertEmail || !tpl) return;
  const msg = replaceAlertVars(tpl, { message, ticket: tv.ticket, url: baseUrl(ctx), company });
  const common = { ticket: tv.ticket, url: baseUrl(ctx), company };
  let sent: string[] = [];
  const members = await deptMembersForAlerts(ctx, dept);
  if (members.length) {
    const recipients: number[] = [];
    const rec = await tx.selectFrom("ticket").select(["staff_id", "team_id"]).where("ticket_id", "=", t.ticketId).executeTakeFirstOrThrow();
    const assigned = !!(rec.staff_id || rec.team_id);
    if (cfg.bool("ticket_alert_dept_members") && !assigned) for (const m of members) if (m !== dept.manager_id) recipients.push(m);
    if (cfg.bool("ticket_alert_dept_manager") && dept.manager_id) recipients.push(dept.manager_id);
    if (cfg.bool("ticket_alert_acct_manager")) {
      const org = await tx
        .selectFrom("user as u")
        .innerJoin("organization as o", "o.id", "u.org_id")
        .select(["o.manager"])
        .where("u.id", "=", t.ownerId)
        .executeTakeFirst();
      const code = org?.manager ?? "";
      if (code.startsWith("s")) recipients.push(Number(code.slice(1)));
      else if (code.startsWith("t")) recipients.push(...(await teamAlertMembers(tx, Number(code.slice(1)))));
    }
    sent = await sendStaffAlerts(ctx, { email: alertEmail, msg, vars: common, recipients, thread });
  }
  if (cfg.bool("ticket_alert_admin") && !sent.includes(cfg.str("admin_email")) && dept.group_membership !== Dept.ALERTS_DISABLED) {
    sendAdminAlert(ctx, { email: alertEmail, msg, vars: common, utype: "M", thread });
  }
}

/** Ticket::onAssign: avviso assigned.alert (la nota con i commenti è scritta dal chiamante) */
export async function onAssignAlert(
  ctx: WriteContext,
  t: { ticketId: number; deptId: number },
  assignee: { kind: "staff"; id: number } | { kind: "team"; id: number },
  comments: string,
  noteEntry: { id: number; threadId: number } | null,
): Promise<void> {
  const { tx, cfg } = ctx;
  if (!cfg.bool("assigned_alert_active")) return;
  const dept = await loadDept(tx, t.deptId);
  if (!dept || !(await deptMembersForAlerts(ctx, dept)).length) return;
  const email = await deptEmail(ctx, dept);
  if (!email) return;
  const recipients: number[] = [];
  let assigneeVar: TemplateVariable | string = "";
  if (assignee.kind === "staff") {
    const info = await loadStaffInfo(tx, assignee.id);
    assigneeVar = info ? staffVar(info, cfg) : "";
    if (cfg.bool("assigned_alert_staff")) recipients.push(assignee.id);
  } else {
    const team = await tx.selectFrom("team").select(["team_id", "name", "flags", "lead_id"]).where("team_id", "=", assignee.id).executeTakeFirst();
    if (team) {
      const { VarBag } = await import("../../mail/variables");
      assigneeVar = new VarBag({ name: team.name, id: team.team_id }, team.name);
      if (!(team.flags & Team.NOALERTS)) {
        const members = await teamAlertMembers(tx, team.team_id);
        if (cfg.bool("assigned_alert_team_members") && members.length) recipients.push(...members);
        else if (cfg.bool("assigned_alert_team_lead") && team.lead_id) recipients.push(team.lead_id);
      }
    }
  }
  const tpl = recipients.length ? await deptMsgTemplate(ctx, dept.id, "assigned.alert") : null;
  if (!tpl) return;
  const tv = await buildTicketVars(tx, t.ticketId, cfg, ctx.dbZone);
  if (!tv) return;
  const assignerInfo = ctx.agent ? await loadStaffInfo(tx, ctx.agent.id) : null;
  const assigner: TemplateVariable | string = assignerInfo ? staffVar(assignerInfo, cfg) : "SYSTEM (Auto Assignment)";
  const company = await companyVar(tx);
  const msg = replaceAlertVars(tpl, { comments: comments || "", assignee: assigneeVar, assigner, ticket: tv.ticket, url: baseUrl(ctx), company });
  await sendStaffAlerts(ctx, {
    email,
    msg,
    vars: { ticket: tv.ticket, url: baseUrl(ctx), company },
    recipients,
    thread: noteEntry ? { entryId: noteEntry.id, threadId: noteEntry.threadId } : undefined,
  });
}

/** Ticket::open: notifica `ticket.notice` del nuovo ticket aperto per conto del cliente */
export async function sendNewTicketNotice(
  ctx: WriteContext,
  t: { ticketId: number; threadId: number; deptId: number; messageId: number; responseId: number },
  recipients: { to: MailContact[]; cc: MailContact[] },
  signatureType: string,
): Promise<void> {
  const { tx, cfg, agent } = ctx;
  const dept = await loadDept(tx, t.deptId);
  if (!dept) return;
  const tpl = await deptMsgTemplate(ctx, dept.id, "ticket.notice");
  const email = await deptEmail(ctx, dept);
  if (!tpl || !email) return;
  const attachments: { filename: string; content: Buffer; contentType: string }[] = [];
  if (cfg.bool("email_attachments")) {
    if (t.messageId) attachments.push(...(await entryAttachmentsForMail(tx, t.messageId)));
    if (t.responseId) attachments.push(...(await entryAttachmentsForMail(tx, t.responseId)));
  }
  let signature = "";
  if (signatureType === "mine" && agent) signature = (await loadStaffInfo(tx, agent.id))?.signature ?? "";
  else if (signatureType === "dept" && dept.ispublic) signature = dept.signature;
  const tv = await buildTicketVars(tx, t.ticketId, cfg, ctx.dbZone);
  if (!tv) return;
  const staffInfo = agent ? await loadStaffInfo(tx, agent.id) : null;
  const r = new VariableReplacer().assign({
    message: (await entryTemplateVar(ctx, t.messageId)) || "",
    response: (await entryTemplateVar(ctx, t.responseId)) || "",
    signature,
    recipient: tv.ownerVar,
    staff: staffInfo ? staffVar(staffInfo, cfg) : "",
    ticket: tv.ticket,
    url: baseUrl(ctx),
    company: await companyVar(tx),
  });
  const subject = r.replaceVars(tpl.subj);
  const body = r.replaceVars(tpl.body);
  if (!recipients.to.length && !recipients.cc.length) return;
  ctx.after.push(async () => {
    await sendMail({
      email,
      to: recipients.to,
      cc: recipients.cc,
      subject,
      body,
      recipient: { userId: 0, utype: "M" },
      thread: { entryId: t.messageId, threadId: t.threadId },
      attachments: attachments.length ? attachments : undefined,
    });
  });
}

/** Ticket::onOpenLimit: log (con avviso all'amministratore), notifica `ticket.overlimit` al cliente e "Overlimit Notice" */
export async function onOpenLimit(
  ctx: WriteContext,
  t: { ticketId: number; deptId: number; email: string; ip: string; numOpenTickets: () => Promise<number> },
  sendNotice: boolean,
): Promise<void> {
  const { tx, cfg } = ctx;
  const max = cfg.int("max_open_tickets");
  const warn = await logWithAdminAlert(cfg, "Warning", `Maximum Open Tickets Limit (${t.email})`, `Maximum open tickets (${max}) reached for ${t.email}`, t.ip, tx);
  if (warn) ctx.after.push(async () => void (await sendMail(warn)));
  if (!sendNotice || !cfg.bool("overlimit_notice_active")) return;
  const dept = await loadDept(tx, t.deptId);
  const tpl = dept ? await deptMsgTemplate(ctx, dept.id, "ticket.overlimit") : null;
  const email = dept ? await deptAutoRespEmail(ctx, dept) : null;
  const tv = await buildTicketVars(tx, t.ticketId, cfg, ctx.dbZone);
  if (dept && tpl && email && tv && tv.owner && tv.ownerVar) {
    const r = new VariableReplacer().assign({ signature: dept.ispublic ? dept.signature : "", ticket: tv.ticket, url: baseUrl(ctx), company: await companyVar(tx) });
    const subject = r.replaceVars(tpl.subj);
    const body = r.replaceVars(tpl.body);
    const to = [{ name: tv.ownerVar.asVar(r), address: tv.owner.email }];
    const ownerId = tv.owner.id;
    ctx.after.push(async () => {
      await sendMail({ email, to, subject, body, recipient: { userId: ownerId, utype: "U" }, autoreply: true });
    });
  }
  // Avviso all'amministratore (sempre, anche senza modello: "might be spammy... but it is helpful")
  const alert =
    `Maximum open tickets reached for ${t.email}.\n` + `Open tickets: ${await t.numOpenTickets()}\n` + `Max allowed: ${max}` + "\n\nNotice sent to the user.";
  const mail = await adminAlertMail(cfg, "Overlimit Notice", alert, tx);
  ctx.after.push(async () => void (await sendMail(mail)));
}

/**
 * FA_SendEmail::apply (azione di filtro "Send an Email", eseguita dopo la creazione): oggetto e
 * messaggio con le variabili del ticket, destinatari con `%{user}` = "nome" <email> del richiedente,
 * un invio per destinatario con `%{recipient}` disponibile; mittente = email `from` della
 * configurazione (altrimenti il mailer di sistema).
 */
export async function sendFilterEmail(
  ctx: WriteContext,
  ticketId: number,
  config: Record<string, unknown>,
  submitter: { name: string; email: string },
): Promise<void> {
  const { tx, cfg } = ctx;
  const tv = await buildTicketVars(tx, ticketId, cfg, ctx.dbZone);
  if (!tv) return;
  // TicketOwner: gli attributi sconosciuti passano da __call e valgono false → la variabile resta nel
  // testo per la seconda sostituzione (es. %{recipient.personal} risolta con il destinatario)
  const owner = tv.ownerVar;
  const ownerFirst = owner
    ? { getVar: (tag: string, r: VariableReplacer) => owner.getVar(tag, r) || false, asVar: (r: VariableReplacer) => owner.asVar(r) }
    : null;
  const first = new VariableReplacer().assign({ url: baseUrl(ctx), ticket: tv.ticket, recipient: ownerFirst, company: await companyVar(tx) });
  const info = { subject: first.replaceVars(String(config.subject ?? "")), message: first.replaceVars(String(config.message ?? "")) };
  const from = await loadSystemEmail(Number(config.from) || 0, tx);
  const replacer = new VariableReplacer().assign({ user: `"${submitter.name}" <${submitter.email}>` });
  const to = replacer.replaceVars(String(config.recipients ?? ""));
  // Mail_Parse::parseAddressList: Mail_RFC822 senza validazione degli atomi; lista vuota → nessun invio
  const mails = to ? parseAddressList(to, { validate: false }) : [];
  if (!mails?.length) return;
  const { VarBag } = await import("../../mail/variables");
  for (const R of mails) {
    // un gruppo ("Nome: a@b;") non ha mailbox: il PHP tenterebbe un invio non valido
    if (R.group) continue;
    const personal = R.personal.replace(/^"|"$/g, "");
    const address = `${R.mailbox}@${R.host}`;
    // Differenza: il PHP passa "personal <box@host>" come stringa a Message::addTo e il nome tra
    // virgolette finisce codificato con le virgolette (=?utf-8?Q?"Nome"?=); qui il nome è senza virgolette
    replacer.assign({ recipient: new VarBag({ host: R.host, domain: R.host, personal, mailbox: R.mailbox }, address) });
    const subject = replacer.replaceVars(info.subject);
    const body = replacer.replaceVars(info.message);
    ctx.after.push(async () => {
      await sendMail({ email: from, to: [{ name: personal, address }], subject, body, recipient: { userId: 0, utype: "?" } });
    });
  }
}
