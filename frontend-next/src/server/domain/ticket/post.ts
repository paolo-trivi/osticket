import "server-only";

import { sql } from "kysely";

import { table, type DbOrTx } from "../../db";
import { buildTicketVars, companyVar, entryVar, loadStaffInfo, loadUserContact, staffVar, ticketLink, userPersonsName } from "../../mail/objects";
import { loadSystemEmail, sendMail, type MailContact, type SystemEmail } from "../../mail/mailer";
import { loadMsgTemplate, templateGroupFor } from "../../mail/templates";
import { VariableReplacer, type TemplateVariable } from "../../mail/variables";
import { loadAgent } from "../staff/staff";
import { createThreadEntry, lastMessage, touchThread, type EntryRecipients } from "../thread/write";
import { agentDisplayName, type WriteContext } from "./context";
import { TicketRecord } from "./record";
import { DeptFlag, lastRespondentId, loadStatus, setTicketStatus, stateOf } from "./status";

/** Thread del ticket */
export async function ticketThreadId(executor: DbOrTx, ticketId: number): Promise<number> {
  const th = await executor.selectFrom("thread").select("id").where("object_type", "=", "T").where("object_id", "=", ticketId).executeTakeFirst();
  if (!th) throw new Error(`Thread del ticket ${ticketId} mancante`);
  return th.id;
}

interface Contact {
  kind: "owner" | "collab";
  /** id nel MailingList: user_id per il proprietario, id del collaboratore per i collaboratori */
  listId: number;
  userId: number;
  name: string;
  email: string;
}

/** Ticket::getRecipients($who, $whitelist) con i collaboratori attivi (flag 1). */
async function ticketRecipients(ctx: WriteContext, ticket: { user_id: number }, threadId: number, who: string, whitelist?: number[]) {
  const to: Contact[] = [];
  const cc: Contact[] = [];
  const nameOf = (u: { name: string; email: string; id: number; org_name: string | null }) => userPersonsName(u, ctx.cfg).toString();
  if (who === "user" || who === "all") {
    const owner = await loadUserContact(ctx.tx, ticket.user_id);
    if (owner) to.push({ kind: "owner", listId: owner.id, userId: owner.id, name: nameOf(owner), email: owner.email });
  }
  if (who === "all" || who === "collabs") {
    const collabs = await ctx.tx
      .selectFrom("thread_collaborator")
      .select(["id", "user_id", "flags"])
      .where("thread_id", "=", threadId)
      .orderBy("id")
      .execute();
    for (const c of collabs) {
      if (!(c.flags & 1)) continue;
      if (whitelist?.length && !whitelist.includes(c.user_id)) continue;
      const u = await loadUserContact(ctx.tx, c.user_id);
      if (u) cc.push({ kind: "collab", listId: c.id, userId: c.user_id, name: nameOf(u), email: u.email });
    }
  }
  if (!["user", "all", "collabs"].includes(who)) return null;
  return { to, cc };
}

function recipientsJson(r: { to: Contact[]; cc: Contact[] }): EntryRecipients {
  const out: EntryRecipients = {};
  for (const [k, list] of [["to", r.to], ["cc", r.cc]] as const) {
    if (!list.length) continue;
    out[k] = {};
    for (const c of list) out[k]![String(c.listId)] = `${c.name} <${c.email}>`;
  }
  return out;
}

async function deptEmail(ctx: WriteContext, deptId: number): Promise<SystemEmail | null> {
  const d = await ctx.tx.selectFrom("department").select(["email_id"]).where("id", "=", deptId).executeTakeFirst();
  return (await loadSystemEmail(d?.email_id ?? 0, ctx.tx)) ?? (await loadSystemEmail(ctx.cfg.int("default_email_id"), ctx.tx));
}

/** Membri del reparto disponibili per gli avvisi (Dept::getMembersForAlerts). */
async function deptAlertMemberCount(executor: DbOrTx, deptId: number): Promise<number> {
  const d = await executor.selectFrom("department").select(["group_membership", "manager_id"]).where("id", "=", deptId).executeTakeFirst();
  if (!d || d.group_membership === 2) return 0;
  const { rows } = await sql<{ n: number }>`SELECT COUNT(DISTINCT S.staff_id) AS n FROM ${table("staff")} S
    LEFT JOIN ${table("staff_dept_access")} A ON (A.staff_id = S.staff_id AND A.dept_id = ${deptId})
    WHERE S.isactive = 1 AND S.onvacation = 0
      AND (S.dept_id = ${deptId} OR S.staff_id = ${d.manager_id} OR A.dept_id = ${deptId})
      AND (S.dept_id = ${deptId} OR (${d.group_membership} = 1 AND (A.flags & 1) != 0))`.execute(executor);
  return Number(rows[0]?.n ?? 0);
}

/**
 * Ticket::onActivity: avviso "nuova attività" (template note.alert) agli agenti interessati.
 * Le email partono dopo il commit (ctx.after).
 */
export async function onActivity(
  ctx: WriteContext,
  rec: TicketRecord,
  threadId: number,
  vars: { activity: string; entry: { id: number; staff_id: number }; assigneeId: number },
  alert = true,
): Promise<void> {
  const { tx, cfg } = ctx;
  if (!alert || !cfg.bool("note_alert_active")) return;
  if (!(await deptAlertMemberCount(tx, rec.get("dept_id")))) return;
  const email = (await loadSystemEmail(cfg.int("alert_email_id"), tx)) ?? (await loadSystemEmail(cfg.int("default_email_id"), tx));
  if (!email) return;
  const tpl = await loadMsgTemplate(tx, await templateGroupFor(tx, rec.get("dept_id"), cfg), "note.alert");
  if (!tpl) return;

  const recipients: number[] = [];
  if (cfg.bool("note_alert_laststaff")) {
    const last = await lastRespondentId(tx, threadId);
    if (last) recipients.push(last);
  }
  const state = await stateOf(tx, rec.row);
  if (cfg.bool("note_alert_assigned")) {
    if (vars.assigneeId) recipients.push(vars.assigneeId);
    else if (state === "open" && rec.get("staff_id")) recipients.push(rec.get("staff_id"));
    if (rec.get("team_id")) {
      const members = await tx
        .selectFrom("team_member")
        .select("staff_id")
        .where("team_id", "=", rec.get("team_id"))
        .where(sql<boolean>`(flags & 1) != 0`)
        .execute();
      recipients.push(...members.map((m) => m.staff_id));
    }
  }
  if (cfg.bool("note_alert_dept_manager")) {
    const d = await tx.selectFrom("department").select("manager_id").where("id", "=", rec.get("dept_id")).executeTakeFirst();
    if (d?.manager_id) recipients.push(d.manager_id);
  }

  const posterStaff = vars.entry.staff_id || (ctx.actor?.kind === "staff" ? ctx.actor.id : 0);
  const entryRow = await tx.selectFrom("thread_entry").selectAll().where("id", "=", vars.entry.id).executeTakeFirstOrThrow();
  const tv = await buildTicketVars(tx, rec.id, cfg, ctx.dbZone);
  if (!tv) return;
  const poster = await loadStaffInfo(tx, entryRow.staff_id);
  const entry = entryVar(entryRow, cfg, ctx.dbZone, poster ? staffVar(poster, cfg) : null);
  const company = await companyVar(tx);
  const base: Record<string, unknown> = {
    ticket: tv.ticket,
    note: entry,
    activity: vars.activity,
    comments: entry,
    url: cfg.str("helpdesk_url").replace(/\/+$/, ""),
    company,
  };

  const sent = new Set<string>();
  for (const staffId of recipients) {
    const staff = await loadAgent(staffId, tx);
    if (!staff || !staff.isAvailable || staff.id === posterStaff || sent.has(staff.email)) continue;
    if (state === "closed") {
      const { checkStaffPerm, loadTicket } = await import("./ticket");
      const t = await loadTicket(rec.id, staff.id, tx);
      if (!t || !(await checkStaffPerm(t, staff, undefined, tx))) continue;
    }
    const info = await loadStaffInfo(tx, staff.id);
    const recipientVar = info ? staffVar(info, cfg) : null;
    const r = new VariableReplacer().assign({ ...base, recipient: recipientVar });
    const subject = r.replaceVars(tpl.subj);
    const body = r.replaceVars(tpl.body);
    const to: MailContact = { name: agentDisplayName(staff, cfg), address: staff.email };
    ctx.after.push(async () => {
      await sendMail({ email, to: [to], subject, body, recipient: { userId: staff.id, utype: "S" }, thread: { entryId: vars.entry.id, threadId }, notice: true });
    });
    sent.add(staff.email);
  }
}

export interface PostNoteInput {
  ticketId: number;
  note: string;
  title?: string;
  format?: "html" | "text";
  statusId?: number;
  alert?: boolean;
  activity?: string;
}

/** Ticket::postNote (include/class.ticket.php:3509) per un agente. */
export async function postNote(ctx: WriteContext, input: PostNoteInput): Promise<{ entryId: number } | { error: string }> {
  const { tx, cfg, agent } = ctx;
  const rec = await TicketRecord.load(tx, input.ticketId, true);
  if (!rec) return { error: "not_found" };
  if (!input.note || !input.note.trim()) return { error: "note_required" };
  const threadId = await ticketThreadId(tx, rec.id);
  const poster = agent ? agentDisplayName(agent, cfg) : "SYSTEM";

  const entry = await createThreadEntry(tx, cfg, {
    threadId,
    type: "N",
    body: input.note,
    format: input.format ?? (cfg.bool("enable_richtext") ? "html" : "text"),
    title: input.title ?? "",
    staffId: agent?.id ?? 0,
    userId: 0,
    poster,
    ip: ctx.actor?.ip ?? "",
  });

  const assigneeId = rec.get("staff_id");
  if (input.statusId && (await loadStatus(tx, input.statusId))) {
    await setTicketStatus(ctx, rec, threadId, input.statusId, { logNote: (t, b) => logNote(ctx, rec.id, t, b) });
  }
  await onActivity(ctx, rec, threadId, { activity: input.activity ?? "New Internal Note", entry: { id: entry.id, staff_id: agent?.id ?? 0 }, assigneeId }, input.alert ?? true);
  return { entryId: entry.id };
}

/** Ticket::logNote: nota HTML dell'agente corrente (o di sistema). */
export async function logNote(ctx: WriteContext, ticketId: number, title: string, note: string, alert = true): Promise<void> {
  await postNote(ctx, { ticketId, note, title, format: "html", alert });
}

export interface PostReplyInput {
  ticketId: number;
  response: string;
  format?: "html" | "text";
  /** reply-to: all | user | none */
  replyTo?: string;
  ccs?: number[];
  signature?: "none" | "mine" | "dept";
  statusId?: number;
  alert?: boolean;
  claim?: boolean;
  fromEmailId?: number;
}

/** Ticket::postReply (include/class.ticket.php:3345) per un agente. */
export async function postReply(ctx: WriteContext, input: PostReplyInput): Promise<{ entryId: number } | { error: string }> {
  const { tx, cfg, agent } = ctx;
  if (!agent) return { error: "forbidden" };
  const rec = await TicketRecord.load(tx, input.ticketId, true);
  if (!rec) return { error: "not_found" };
  if (!input.response || !input.response.trim()) return { error: "response_required" };
  const threadId = await ticketThreadId(tx, rec.id);

  const recipients = await ticketRecipients(ctx, rec.row, threadId, input.replyTo ?? "all", input.ccs);
  const last = await lastMessage(tx, threadId);
  const entry = await createThreadEntry(tx, cfg, {
    threadId,
    type: "R",
    body: input.response,
    format: input.format ?? (cfg.bool("enable_richtext") ? "html" : "text"),
    staffId: agent.id,
    userId: 0,
    poster: agentDisplayName(agent, cfg),
    pid: last?.id,
    ip: ctx.actor?.ip ?? "",
    recipients: recipients ? recipientsJson(recipients) : undefined,
  });
  await touchThread(tx, threadId, "lastresponse");

  const assigneeId = rec.get("staff_id");
  if (input.statusId && input.statusId !== rec.get("status_id") && (await loadStatus(tx, input.statusId))) {
    await setTicketStatus(ctx, rec, threadId, input.statusId, { logNote: (t, b) => logNote(ctx, rec.id, t, b) });
  }

  // Claim on response
  const dept = await tx.selectFrom("department").select(["flags", "ispublic", "signature", "name"]).where("id", "=", rec.get("dept_id")).executeTakeFirst();
  const claim = (input.claim ?? true) && cfg.bool("auto_claim_tickets") && !(dept && dept.flags & DeptFlag.DISABLE_AUTO_CLAIM);
  if (claim && (await stateOf(tx, rec.row)) === "open" && !rec.get("staff_id")) {
    rec.set("staff_id", agent.id);
    await rec.save();
  }

  // onResponse
  rec.set("isanswered", 1);
  await rec.save();
  await onActivity(ctx, rec, threadId, { activity: "New Response", entry: { id: entry.id, staff_id: agent.id }, assigneeId });

  if (!(input.alert ?? true) || !recipients) return { entryId: entry.id };

  const email = input.fromEmailId ? ((await loadSystemEmail(input.fromEmailId, tx)) ?? (await deptEmail(ctx, rec.get("dept_id")))) : await deptEmail(ctx, rec.get("dept_id"));
  let signature = "";
  if (input.signature === "mine") signature = (await loadStaffInfo(tx, agent.id))?.signature ?? "";
  else if (input.signature === "dept" && dept?.ispublic) signature = dept.signature ?? "";

  let fromName = "";
  const type = agent.config.str("default_from_name");
  if (type) {
    if (type === "mine") fromName = cfg.bool("hide_staff_name") ? "" : agentDisplayName(agent, cfg);
    else if (type === "dept") fromName = dept?.ispublic ? (dept.name ?? "") : "";
    else fromName = email?.name ?? "";
  }

  const tpl = email ? await loadMsgTemplate(tx, await templateGroupFor(tx, rec.get("dept_id"), cfg), "ticket.reply") : null;
  if (!email || !tpl || (!recipients.to.length && !recipients.cc.length)) return { entryId: entry.id };

  const tv = await buildTicketVars(tx, rec.id, cfg, ctx.dbZone);
  if (!tv) return { entryId: entry.id };
  const staffInfo = await loadStaffInfo(tx, agent.id);
  const staffV: TemplateVariable | null = staffInfo ? staffVar(staffInfo, cfg) : null;
  const entryRow = await tx.selectFrom("thread_entry").selectAll().where("id", "=", entry.id).executeTakeFirstOrThrow();
  const vars: Record<string, unknown> = {
    response: entryVar(entryRow, cfg, ctx.dbZone, staffV),
    signature,
    staff: staffV,
    poster: staffV,
    ticket: tv.ticket,
    recipient: tv.ownerVar,
    url: cfg.str("helpdesk_url").replace(/\/+$/, ""),
    company: await companyVar(tx),
  };
  const total = recipients.to.length + recipients.cc.length;
  if (total === 1 && tv.numCollaborators && recipients.to[0]?.kind === "owner" && tv.owner) {
    vars["recipient.ticket_link"] = ticketLink(cfg, tv.info, { isOwner: true, id: tv.owner.id }, true);
  }
  const r = new VariableReplacer().assign(vars);
  const subject = r.replaceVars(tpl.subj);
  const body = r.replaceVars(tpl.body);

  // In-Reply-To / References dall'ultimo messaggio arrivato via email
  const lastEmail = await lastMessage(tx, threadId, { emailOnly: true });
  let references: string | null = null;
  if (lastEmail?.mid) {
    const refHeader = /^References:\s*((?:.*(?:\r?\n[ \t]+.*)*))/im.exec(lastEmail.headers ?? "")?.[1]?.replace(/\r?\n[ \t]+/g, " ").trim();
    references = `${refHeader ? `${refHeader} ` : ""}${lastEmail.mid}`;
  }
  const to = recipients.to.map((c) => ({ name: c.name, address: c.email }));
  const cc = recipients.cc.map((c) => ({ name: c.name, address: c.email }));
  ctx.after.push(async () => {
    await sendMail({
      email,
      fromName,
      to,
      cc,
      subject,
      body,
      recipient: { userId: 0, utype: "M" },
      thread: { entryId: entry.id, threadId, inReplyTo: lastEmail?.mid ?? null, references },
    });
  });
  return { entryId: entry.id };
}

