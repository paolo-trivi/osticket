import "server-only";

import { sql } from "kysely";

import { Dept } from "@/lib/osticket/flags";

import { table } from "../../db";
import type { SystemEmail } from "../../mail/mailer";
import { companyVar, loadStaffInfo, staffVar } from "../../mail/objects";
import type { TemplateCode } from "../../mail/templates";
import type { TemplateVariable } from "../../mail/variables";
import { alertOrDefaultEmail } from "../directory/content-mail";
import {
  deptAlertEmail as deptEmailOf,
  deptAlertMembers,
  deptMsgTemplate,
  replaceAlertVars,
  sendAdminAlert,
  sendStaffAlerts,
  teamAlertMembers,
} from "../staff-alerts";
import type { Agent } from "../staff/staff";
import type { WriteContext } from "../ticket/context";
import type { TaskDbRow } from "./model";
import { checkTaskPerm, loadTask } from "./tasks";
import { activityVar, taskVar, threadEntryVar } from "./vars";
import { isOpen } from "./common";

/**
 * Avvisi email dei task (Task::onActivity, Task::onNewTask e l'invio comune con la doppia sostituzione
 * di Task::replaceVars): task.alert, task.activity.alert; destinatari e mittenti degli altri avvisi.
 */

/**
 * Invio di un avviso del task (Task::replaceVars): primo passaggio con le variabili dell'operazione, il
 * secondo con le stesse variabili più il destinatario; avviso all'amministratore facoltativo.
 */
export async function sendTaskAlerts(
  ctx: WriteContext,
  opts: {
    email: SystemEmail | null;
    code: TemplateCode;
    deptId: number;
    recipients: number[];
    vars: Record<string, unknown>;
    skip?: (staff: Agent) => Promise<boolean> | boolean;
    thread?: { entryId: number; threadId: number };
    adminAlert?: boolean;
  },
): Promise<void> {
  const { tx, cfg } = ctx;
  if (!opts.email) return;
  const tpl = await deptMsgTemplate(ctx, opts.deptId, opts.code);
  if (!tpl) return;
  const vars = { ...opts.vars, url: cfg.str("helpdesk_url").replace(/\/+$/, ""), company: await companyVar(tx) };
  const msg = replaceAlertVars(tpl, vars);
  const email = opts.email;
  await sendStaffAlerts(ctx, { email, msg, vars, recipients: opts.recipients, skip: opts.skip, thread: opts.thread });
  // Bug PHP replicato: in_array() cerca l'indirizzo tra i valori di $sentlist (tutti 1), quindi
  // l'amministratore riceve l'avviso anche se è già tra gli agenti avvisati.
  if (opts.adminAlert && cfg.str("admin_email")) sendAdminAlert(ctx, { email, msg, vars, utype: "?", thread: opts.thread });
}

/** $cfg->getAlertEmail(): email degli avvisi o predefinita */
function alertEmail(ctx: WriteContext): Promise<SystemEmail | null> {
  return alertOrDefaultEmail(ctx.tx, ctx.cfg);
}

/** Dept::getAlertEmail(): email del reparto o email predefinita */
export async function deptAlertEmail(ctx: WriteContext, deptId: number): Promise<SystemEmail | null> {
  const d = await ctx.tx.selectFrom("department").select("email_id").where("id", "=", deptId).executeTakeFirst();
  return deptEmailOf(ctx.tx, ctx.cfg, d?.email_id);
}

/** Dept::getMembersForAlerts() del reparto indicato */
export async function deptMembersForAlerts(ctx: WriteContext, deptId: number): Promise<number[]> {
  const d = await ctx.tx.selectFrom("department").select(["id", "manager_id", "group_membership"]).where("id", "=", deptId).executeTakeFirst();
  return d ? deptAlertMembers(ctx.tx, d, ctx.cfg.str("agent_name_format")) : [];
}

export async function staffTemplateVar(ctx: WriteContext, staffId: number): Promise<TemplateVariable | null> {
  const info = await loadStaffInfo(ctx.tx, staffId);
  return info ? staffVar(info, ctx.cfg) : null;
}

/** Task::onActivity: avviso task.activity.alert */
export async function onActivity(
  ctx: WriteContext,
  task: TaskDbRow,
  threadId: number,
  entry: { id: number; staffId: number },
  activity: [string, string],
  assigneeId: number,
  alert = true,
): Promise<void> {
  const { tx, cfg } = ctx;
  if (!alert || !cfg.bool("task_activity_alert_active")) return;
  const email = await alertEmail(ctx);
  if (!email) return;
  const recipients: number[] = [];
  if (cfg.bool("task_activity_alert_laststaff")) {
    const { rows } = await sql<{ staff_id: number }>`SELECT staff_id FROM ${table("thread_entry")}
      WHERE thread_id = ${threadId} AND type = 'R' AND staff_id > 0 ORDER BY id DESC LIMIT 1`.execute(tx);
    if (rows[0]) recipients.push(rows[0].staff_id);
  }
  if (cfg.bool("task_activity_alert_assigned")) {
    if (assigneeId) recipients.push(assigneeId);
    else if (isOpen(task) && task.staff_id) recipients.push(task.staff_id);
    if (task.team_id) recipients.push(...(await teamAlertMembers(tx, task.team_id)));
  }
  if (cfg.bool("task_activity_alert_dept_manager")) {
    const d = await tx.selectFrom("department").select("manager_id").where("id", "=", task.dept_id).executeTakeFirst();
    if (d?.manager_id) recipients.push(d.manager_id);
  }
  const poster = entry.staffId || (ctx.actor?.kind === "staff" ? ctx.actor.id : 0);
  const message = await threadEntryVar(tx, entry.id, cfg, ctx.dbZone);
  const closed = !isOpen(task);
  const row = await loadTask(task.id, tx);
  await sendTaskAlerts(ctx, {
    email,
    code: "task.activity.alert",
    deptId: task.dept_id,
    recipients,
    vars: { task: await taskVar(tx, task, cfg, ctx.dbZone), note: message, activity: activityVar(...activity), message },
    skip: (s) => s.id === poster || (closed && !!row && !checkTaskPerm(row, s)),
    thread: { entryId: entry.id, threadId },
  });
}

/** Task::onNewTask: avviso task.alert */
export async function onNewTask(ctx: WriteContext, task: TaskDbRow): Promise<void> {
  const { tx, cfg } = ctx;
  if (!cfg.bool("task_alert_active")) return;
  const dept = await tx.selectFrom("department").select(["group_membership", "manager_id"]).where("id", "=", task.dept_id).executeTakeFirst();
  if (!dept || dept.group_membership === Dept.ALERTS_DISABLED) return;
  const email = await alertEmail(ctx);
  if (!email) return;
  const adminOnly = dept.group_membership === Dept.ALERTS_ADMIN_ONLY;
  const recipients: number[] = [];
  if (cfg.bool("task_alert_dept_manager") && dept.manager_id && !adminOnly) recipients.push(dept.manager_id);
  if (cfg.bool("task_alert_dept_members") && !adminOnly) recipients.push(...(await deptMembersForAlerts(ctx, task.dept_id)));
  const poster = ctx.actor?.kind === "staff" ? ctx.actor.id : 0;
  const row = await loadTask(task.id, tx);
  await sendTaskAlerts(ctx, {
    email,
    code: "task.alert",
    deptId: task.dept_id,
    recipients,
    vars: { task: await taskVar(tx, task, cfg, ctx.dbZone) },
    skip: (s) => s.id === poster || !row || !checkTaskPerm(row, s),
    adminAlert: cfg.bool("task_alert_admin"),
  });
}
