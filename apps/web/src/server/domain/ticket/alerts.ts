import "server-only";

import { sql } from "kysely";

import { table, type DbOrTx } from "../../db";
import { PersonsName } from "../../format/persons-name";
import { loadSystemEmail, sendMail, type SystemEmail } from "../../mail/mailer";
import { buildTicketVars, companyVar, loadStaffInfo, staffVar } from "../../mail/objects";
import { loadMsgTemplate, templateGroupFor, type TemplateCode } from "../../mail/templates";
import { VariableReplacer } from "../../mail/variables";
import type { WriteContext } from "./context";

/**
 * Supporto agli avvisi email per agenti delle azioni sul ticket (Ticket::onAssign, Ticket::transfer):
 * membri del reparto per gli avvisi, membri del team, email e template del reparto, invio
 * con la doppia sostituzione di variabili del PHP.
 */

/** Dept::ALERTS_* (colonna department.group_membership) */
const ALERTS_DEPT_AND_EXTENDED = 1;
const ALERTS_DISABLED = 2;

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

/** Ordinamento di Staff::nsort secondo agent_name_format. */
export function staffSortColumns(format: string): ["firstname" | "lastname", "firstname" | "lastname"] {
  return ["last", "lastfirst", "legal"].includes(format) ? ["lastname", "firstname"] : ["firstname", "lastname"];
}

/**
 * Dept::getMembersForAlerts(): membri disponibili (attivi, non in ferie) primari, oppure con accesso
 * esteso con avvisi attivi se il reparto li estende; ordinati con Staff::nsort.
 */
export async function deptAlertMembers(executor: DbOrTx, dept: DeptRow, nameFormat: string): Promise<number[]> {
  if (dept.group_membership === ALERTS_DISABLED) return [];
  const [a, b] = staffSortColumns(nameFormat);
  const { rows } = await sql<{ staff_id: number }>`SELECT DISTINCT S.staff_id, S.${sql.ref(a)}, S.${sql.ref(b)} FROM ${table("staff")} S
    LEFT JOIN ${table("staff_dept_access")} A ON (A.staff_id = S.staff_id AND A.dept_id = ${dept.id})
    WHERE S.isactive = 1 AND S.onvacation = 0
      AND (S.dept_id = ${dept.id} OR S.staff_id = ${dept.manager_id} OR A.dept_id = ${dept.id})
      AND (S.dept_id = ${dept.id} OR (${dept.group_membership} = ${ALERTS_DEPT_AND_EXTENDED} AND (A.flags & 1) != 0))
    ORDER BY S.${sql.ref(a)}, S.${sql.ref(b)}`.execute(executor);
  return rows.map((r) => r.staff_id);
}

/** Dept::isMember($staff): primario, manager o con accesso esteso (senza filtro su attivo/ferie). */
export async function deptIsMember(executor: DbOrTx, dept: DeptRow, staffId: number): Promise<boolean> {
  if (!staffId) return false;
  const { rows } = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM ${table("staff")} S
    LEFT JOIN ${table("staff_dept_access")} A ON (A.staff_id = S.staff_id AND A.dept_id = ${dept.id})
    WHERE S.staff_id = ${staffId} AND (S.dept_id = ${dept.id} OR S.staff_id = ${dept.manager_id} OR A.dept_id = ${dept.id})`.execute(executor);
  return Number(rows[0]?.n ?? 0) > 0;
}

/** Team::getMembersForAlerts(): membri con FLAG_ALERTS (inclusi non disponibili, filtrati all'invio). */
export async function teamAlertMembers(executor: DbOrTx, teamId: number): Promise<number[]> {
  const rows = await executor
    .selectFrom("team_member")
    .select("staff_id")
    .where("team_id", "=", teamId)
    .where(sql<boolean>`(flags & 1) != 0`)
    .orderBy("staff_id")
    .execute();
  return rows.map((r) => r.staff_id);
}

/** Dept::getAlertEmail(): email del reparto, altrimenti l'email predefinita (non alert_email_id). */
export async function deptAlertEmail(ctx: WriteContext, dept: DeptRow | null): Promise<SystemEmail | null> {
  return (await loadSystemEmail(dept?.email_id ?? 0, ctx.tx)) ?? (await loadSystemEmail(ctx.cfg.int("default_email_id"), ctx.tx));
}

interface StaffMailRow {
  staff_id: number;
  email: string;
  firstname: string;
  lastname: string;
  isactive: number;
  onvacation: number;
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
  const tpl = await loadMsgTemplate(tx, await templateGroupFor(tx, opts.deptId, cfg), opts.code);
  if (!tpl) return 0;
  const tv = await buildTicketVars(tx, opts.ticketId, cfg, ctx.dbZone);
  if (!tv) return 0;
  const common = { ticket: tv.ticket, url: cfg.str("helpdesk_url").replace(/\/+$/, ""), company: await companyVar(tx) };
  const first = new VariableReplacer().assign({ ...opts.vars, ...common });
  const subj1 = first.replaceVars(tpl.subj);
  const body1 = first.replaceVars(tpl.body);

  const sent: string[] = [];
  let count = 0;
  for (const id of opts.recipients) {
    const s = (await tx
      .selectFrom("staff")
      .select(["staff_id", "email", "firstname", "lastname", "isactive", "onvacation"])
      .where("staff_id", "=", id)
      .executeTakeFirst()) as StaffMailRow | undefined;
    if (!s || !s.isactive || s.onvacation || sent.includes(s.email)) continue;
    const info = await loadStaffInfo(tx, s.staff_id);
    const r = new VariableReplacer().assign({ ...common, recipient: info ? staffVar(info, cfg) : null });
    const subject = r.replaceVars(subj1);
    const body = r.replaceVars(body1);
    const to = { name: new PersonsName({ first: s.firstname ?? "", last: s.lastname ?? "" }, cfg.str("agent_name_format")).toString(), address: s.email };
    const thread = opts.thread ?? undefined;
    const email = opts.email;
    ctx.after.push(async () => {
      await sendMail({ email, to: [to], subject, body, recipient: { userId: s.staff_id, utype: "S" }, thread, notice: true });
    });
    sent.push(s.email);
    count++;
  }
  return count;
}
