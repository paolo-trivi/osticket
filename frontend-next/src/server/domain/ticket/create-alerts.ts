import "server-only";

import { sql } from "kysely";

import { table, type DbOrTx } from "../../db";
import { loadSystemEmail, sendMail, type MailContact, type SystemEmail } from "../../mail/mailer";
import { buildTicketVars, companyVar, entryVar, loadStaffInfo, staffVar } from "../../mail/objects";
import { loadMsgTemplate, templateGroupFor, type TemplateCode } from "../../mail/templates";
import { VariableReplacer, type TemplateVariable } from "../../mail/variables";
import { logSystem } from "../../system/syslog";
import { entryAttachmentsForMail } from "../file/upload";
import { loadAgent, type Agent } from "../staff/staff";
import { agentDisplayName, type WriteContext } from "./context";

/**
 * Notifiche della creazione del ticket (include/class.ticket.php): auto-risposta `ticket.autoresp` e
 * avviso `ticket.alert` (onNewTicket), avviso di assegnazione `assigned.alert` (onAssign), notifica
 * `ticket.notice` al cliente per i ticket aperti da un agente (Ticket::open), limite di ticket aperti
 * (onOpenLimit). Le email partono dopo il commit (ctx.after).
 */

export interface DeptInfo {
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
  return (await loadSystemEmail(dept.email_id, ctx.tx)) ?? (await loadSystemEmail(ctx.cfg.int("default_email_id"), ctx.tx));
}

/** Dept::getAutoRespEmail */
async function deptAutoRespEmail(ctx: WriteContext, dept: DeptInfo): Promise<SystemEmail | null> {
  return (await loadSystemEmail(dept.autoresp_email_id, ctx.tx)) ?? (await deptEmail(ctx, dept));
}

/** Ordinamento dei nomi degli agenti (Staff::getsortby) */
function staffOrder(cfg: WriteContext["cfg"]) {
  return ["last", "lastfirst", "legal"].includes(cfg.str("agent_name_format")) ? sql`S.lastname, S.firstname` : sql`S.firstname, S.lastname`;
}

/** Dept::getMembersForAlerts: membri disponibili primari, o estesi con flag ALERTS se il reparto lo consente */
export async function deptMembersForAlerts(ctx: WriteContext, dept: DeptInfo): Promise<number[]> {
  if (dept.group_membership === 2) return [];
  const { rows } = await sql<{ staff_id: number }>`SELECT DISTINCT S.staff_id, S.firstname, S.lastname FROM ${table("staff")} S
    LEFT JOIN ${table("staff_dept_access")} A ON (A.staff_id = S.staff_id AND A.dept_id = ${dept.id})
    WHERE S.isactive = 1 AND S.onvacation = 0
      AND (S.dept_id = ${dept.id} OR S.staff_id = ${dept.manager_id} OR A.dept_id = ${dept.id})
      AND (S.dept_id = ${dept.id} OR (${dept.group_membership} = 1 AND (A.flags & 1) != 0))
    ORDER BY ${staffOrder(ctx.cfg)}`.execute(ctx.tx);
  return rows.map((r) => r.staff_id);
}

async function staffContact(ctx: WriteContext, agent: Agent): Promise<{ to: MailContact; var: TemplateVariable | null }> {
  const info = await loadStaffInfo(ctx.tx, agent.id);
  return { to: { name: agentDisplayName(agent, ctx.cfg), address: agent.email }, var: info ? staffVar(info, ctx.cfg) : null };
}

async function template(ctx: WriteContext, deptId: number, code: TemplateCode) {
  return loadMsgTemplate(ctx.tx, await templateGroupFor(ctx.tx, deptId, ctx.cfg), code);
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
    const tpl = await template(ctx, dept.id, "ticket.autoresp");
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
  const tpl = await template(ctx, dept.id, "ticket.alert");
  if (!alertEmail || !tpl) return;
  const first = new VariableReplacer().assign({ message, ticket: tv.ticket, url: baseUrl(ctx), company });
  const msg = { subj: first.replaceVars(tpl.subj), body: first.replaceVars(tpl.body) };
  const sent: string[] = [];
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
      else if (code.startsWith("t")) {
        const tm = await tx.selectFrom("team_member").select("staff_id").where("team_id", "=", Number(code.slice(1))).where(sql<boolean>`(flags & 1) != 0`).execute();
        recipients.push(...tm.map((m) => m.staff_id));
      }
    }
    for (const id of recipients) {
      const staff = await loadAgent(id, tx);
      if (!staff || !staff.isAvailable || sent.includes(staff.email)) continue;
      const c = await staffContact(ctx, staff);
      const r = new VariableReplacer().assign({ recipient: c.var, ticket: tv.ticket, url: baseUrl(ctx), company });
      const subject = r.replaceVars(msg.subj);
      const body = r.replaceVars(msg.body);
      ctx.after.push(async () => {
        await sendMail({ email: alertEmail, to: [c.to], subject, body, recipient: { userId: staff.id, utype: "S" }, thread, notice: true });
      });
      sent.push(staff.email);
    }
  }
  const adminEmail = cfg.str("admin_email");
  if (cfg.bool("ticket_alert_admin") && !sent.includes(adminEmail) && dept.group_membership !== 2) {
    const r = new VariableReplacer().assign({ recipient: "Admin", ticket: tv.ticket, url: baseUrl(ctx), company });
    const subject = r.replaceVars(msg.subj);
    const body = r.replaceVars(msg.body);
    ctx.after.push(async () => {
      await sendMail({ email: alertEmail, to: [{ name: "", address: adminEmail }], subject, body, recipient: { userId: 0, utype: "M" }, thread, notice: true });
    });
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
      if (!(team.flags & 0x0002)) {
        const members = await tx
          .selectFrom("team_member")
          .select("staff_id")
          .where("team_id", "=", team.team_id)
          .where(sql<boolean>`(flags & 1) != 0`)
          .execute();
        if (cfg.bool("assigned_alert_team_members") && members.length) recipients.push(...members.map((m) => m.staff_id));
        else if (cfg.bool("assigned_alert_team_lead") && team.lead_id) recipients.push(team.lead_id);
      }
    }
  }
  const tpl = recipients.length ? await template(ctx, dept.id, "assigned.alert") : null;
  if (!tpl) return;
  const tv = await buildTicketVars(tx, t.ticketId, cfg, ctx.dbZone);
  if (!tv) return;
  const assignerInfo = ctx.agent ? await loadStaffInfo(tx, ctx.agent.id) : null;
  const assigner: TemplateVariable | string = assignerInfo ? staffVar(assignerInfo, cfg) : "SYSTEM (Auto Assignment)";
  const company = await companyVar(tx);
  const first = new VariableReplacer().assign({ comments: comments || "", assignee: assigneeVar, assigner, ticket: tv.ticket, url: baseUrl(ctx), company });
  const msg = { subj: first.replaceVars(tpl.subj), body: first.replaceVars(tpl.body) };
  const sent: string[] = [];
  for (const id of recipients) {
    const staff = await loadAgent(id, tx);
    if (!staff || !staff.isAvailable || sent.includes(staff.email)) continue;
    const c = await staffContact(ctx, staff);
    const r = new VariableReplacer().assign({ recipient: c.var, ticket: tv.ticket, url: baseUrl(ctx), company });
    const subject = r.replaceVars(msg.subj);
    const body = r.replaceVars(msg.body);
    const thread = noteEntry ? { entryId: noteEntry.id, threadId: noteEntry.threadId } : undefined;
    ctx.after.push(async () => {
      await sendMail({ email, to: [c.to], subject, body, recipient: { userId: staff.id, utype: "S" }, thread, notice: true });
    });
    sent.push(staff.email);
  }
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
  const tpl = await template(ctx, dept.id, "ticket.notice");
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

/** Ticket::onOpenLimit: log per l'amministratore e notifica `ticket.overlimit` al cliente */
export async function onOpenLimit(ctx: WriteContext, t: { ticketId: number; deptId: number; email: string; openTickets: number }, sendNotice: boolean): Promise<void> {
  const { tx, cfg } = ctx;
  const max = cfg.int("max_open_tickets");
  await logSystem("Warning", `Maximum Open Tickets Limit (${t.email})`, `Maximum open tickets (${max}) reached for ${t.email}`, ctx.actor?.ip ?? "", { executor: tx });
  if (!sendNotice || !cfg.bool("overlimit_notice_active")) return;
  const dept = await loadDept(tx, t.deptId);
  if (!dept) return;
  const tpl = await template(ctx, dept.id, "ticket.overlimit");
  const email = await deptAutoRespEmail(ctx, dept);
  const tv = await buildTicketVars(tx, t.ticketId, cfg, ctx.dbZone);
  if (!tpl || !email || !tv || !tv.owner || !tv.ownerVar) return;
  const r = new VariableReplacer().assign({ signature: dept.ispublic ? dept.signature : "", ticket: tv.ticket, url: baseUrl(ctx), company: await companyVar(tx) });
  const subject = r.replaceVars(tpl.subj);
  const body = r.replaceVars(tpl.body);
  const to = [{ name: tv.ownerVar.asVar(r), address: tv.owner.email }];
  const ownerId = tv.owner.id;
  ctx.after.push(async () => {
    await sendMail({ email, to, subject, body, recipient: { userId: ownerId, utype: "U" }, autoreply: true });
  });
}
