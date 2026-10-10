import "server-only";

import { sql } from "kysely";

import { table, type DbOrTx } from "../../db";
import type { SystemEmail } from "../../mail/mailer";
import { buildTicketVars, companyVar } from "../../mail/objects";
import type { TemplateCode } from "../../mail/templates";
import { deptAlertEmail as alertEmailOf, deptMsgTemplate, replaceAlertVars, sendStaffAlerts as deliverStaffAlerts } from "../staff-alerts";
import type { WriteContext } from "./context";

/**
 * Supporto agli avvisi email per agenti delle azioni sul ticket (Ticket::onAssign, Ticket::transfer,
 * Ticket::onOverdue): riga del reparto e invio con le variabili del ticket. Destinatari, deduplica e
 * doppia sostituzione sono nel nucleo comune con i task (../staff-alerts.ts).
 */

export { deptAlertMembers, staffSortColumns, teamAlertMembers } from "../staff-alerts";

export interface DeptRow {
  id: number;
  name: string;
  flags: number;
  manager_id: number;
  sla_id: number;
  email_id: number;
  group_membership: number;
}

export async function loadDept(executor: DbOrTx, id: number): Promise<DeptRow | null> {
  if (!id) return null;
  const d = await executor
    .selectFrom("department")
    .select(["id", "name", "flags", "manager_id", "sla_id", "email_id", "group_membership"])
    .where("id", "=", id)
    .executeTakeFirst();
  return d ? { ...d, name: d.name ?? "", manager_id: d.manager_id ?? 0, sla_id: d.sla_id ?? 0, email_id: d.email_id ?? 0 } : null;
}

/** Dept::isMember($staff): primario, manager o con accesso esteso (senza filtro su attivo/ferie). */
export async function deptIsMember(executor: DbOrTx, dept: DeptRow, staffId: number): Promise<boolean> {
  if (!staffId) return false;
  const { rows } = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM ${table("staff")} S
    LEFT JOIN ${table("staff_dept_access")} A ON (A.staff_id = S.staff_id AND A.dept_id = ${dept.id})
    WHERE S.staff_id = ${staffId} AND (S.dept_id = ${dept.id} OR S.staff_id = ${dept.manager_id} OR A.dept_id = ${dept.id})`.execute(executor);
  return Number(rows[0]?.n ?? 0) > 0;
}

/** Dept::getAlertEmail(): email del reparto, altrimenti l'email predefinita (non alert_email_id). */
export async function deptAlertEmail(ctx: WriteContext, dept: DeptRow | null): Promise<SystemEmail | null> {
  return alertEmailOf(ctx.tx, ctx.cfg, dept?.email_id);
}

/**
 * Invio degli avvisi come il ciclo di onAssign/transfer: prima sostituzione con le variabili
 * dell'evento (+ ticket, url, company), poi una per destinatario con `recipient`; destinatari non
 * disponibili o con email già usata vengono saltati. Le email partono dopo il commit.
 */
export async function sendStaffAlerts(
  ctx: WriteContext,
  opts: {
    ticketId: number;
    deptId: number;
    code: TemplateCode;
    email: SystemEmail;
    vars: Record<string, unknown>;
    recipients: number[];
    /** nota di riferimento (opzione 'thread' del PHP) */
    thread?: { entryId: number; threadId: number } | null;
  },
): Promise<number> {
  const { tx, cfg } = ctx;
  if (!opts.recipients.length) return 0;
  const tpl = await deptMsgTemplate(ctx, opts.deptId, opts.code);
  if (!tpl) return 0;
  const tv = await buildTicketVars(tx, opts.ticketId, cfg, ctx.dbZone);
  if (!tv) return 0;
  const common = { ticket: tv.ticket, url: cfg.str("helpdesk_url").replace(/\/+$/, ""), company: await companyVar(tx) };
  const sent = await deliverStaffAlerts(ctx, {
    email: opts.email,
    msg: replaceAlertVars(tpl, { ...opts.vars, ...common }),
    vars: common,
    recipients: opts.recipients,
    thread: opts.thread ?? undefined,
  });
  return sent.length;
}
