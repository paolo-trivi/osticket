import "server-only";

import { sql } from "kysely";

import { Dept, StaffDeptAccess, TeamMember } from "@/lib/osticket/flags";

import type { ConfigNamespace } from "../config/config";
import { table, type DbOrTx } from "../db";
import { PersonsName } from "../format/persons-name";
import { loadSystemEmail, sendMail, type SystemEmail } from "../mail/mailer";
import type { RecipientClass } from "../mail/message-id";
import { loadStaffInfo, staffVar } from "../mail/objects";
import { loadMsgTemplate, templateGroupFor, type TemplateCode } from "../mail/templates";
import { VariableReplacer } from "../mail/variables";
import { loadAgent, type Agent } from "./staff/staff";
import type { WriteContext } from "./ticket/context";

/**
 * Nucleo comune degli avvisi email agli agenti di ticket e task (Ticket::onNewTicket, onActivity,
 * onAssign, transfer, onOverdue; Task::onNewTask, onActivity, assign, transfer): destinatari (membri del
 * reparto e del team per gli avvisi), email e modello del reparto, invio con la doppia sostituzione di
 * variabili del PHP (`$msg = replaceVars($tpl, $vars)`, poi `replaceVars($msg, ['recipient' => $staff])`)
 * e deduplica per indirizzo ($sentlist). Le email partono dopo il commit (ctx.after).
 */

/** Ordinamento di Staff::nsort secondo agent_name_format. */
export function staffSortColumns(format: string): ["firstname" | "lastname", "firstname" | "lastname"] {
  return ["last", "lastfirst", "legal"].includes(format) ? ["lastname", "firstname"] : ["firstname", "lastname"];
}

interface AlertDept {
  id: number;
  manager_id: number | null;
  group_membership: number;
}

/**
 * Dept::getMembersForAlerts(): membri disponibili (attivi, non in ferie) primari, oppure con accesso
 * esteso con avvisi attivi se il reparto li estende; ordinati con Staff::nsort.
 */
export async function deptAlertMembers(executor: DbOrTx, dept: AlertDept, nameFormat: string): Promise<number[]> {
  if (dept.group_membership === Dept.ALERTS_DISABLED) return [];
  const [a, b] = staffSortColumns(nameFormat);
  const { rows } = await sql<{ staff_id: number }>`SELECT DISTINCT S.staff_id, S.${sql.ref(a)}, S.${sql.ref(b)} FROM ${table("staff")} S
    LEFT JOIN ${table("staff_dept_access")} A ON (A.staff_id = S.staff_id AND A.dept_id = ${dept.id})
    WHERE S.isactive = 1 AND S.onvacation = 0
      AND (S.dept_id = ${dept.id} OR S.staff_id = ${dept.manager_id} OR A.dept_id = ${dept.id})
      AND (S.dept_id = ${dept.id} OR (${dept.group_membership} = ${Dept.ALERTS_DEPT_AND_EXTENDED} AND (A.flags & ${sql.lit(StaffDeptAccess.ALERTS)}) != 0))
    ORDER BY S.${sql.ref(a)}, S.${sql.ref(b)}`.execute(executor);
  return rows.map((r) => r.staff_id);
}

/** Team::getMembersForAlerts(): membri con FLAG_ALERTS (inclusi non disponibili, filtrati all'invio). */
export async function teamAlertMembers(executor: DbOrTx, teamId: number): Promise<number[]> {
  const rows = await executor
    .selectFrom("team_member")
    .select("staff_id")
    .where("team_id", "=", teamId)
    .where(sql<boolean>`(flags & ${sql.lit(TeamMember.ALERTS)}) != 0`)
    .orderBy("staff_id")
    .execute();
  return rows.map((r) => r.staff_id);
}

/** Dept::getAlertEmail() / Dept::getEmail(): email del reparto, altrimenti l'email predefinita. */
export async function deptAlertEmail(executor: DbOrTx, cfg: ConfigNamespace, emailId: number | null | undefined): Promise<SystemEmail | null> {
  return (await loadSystemEmail(emailId ?? 0, executor)) ?? (await loadSystemEmail(cfg.int("default_email_id"), executor));
}

interface AlertMessage {
  subj: string;
  body: string;
}

/** Modello del gruppo del reparto (Dept::getTemplate()->get…MsgTemplate()). */
export async function deptMsgTemplate(ctx: WriteContext, deptId: number, code: TemplateCode): Promise<AlertMessage | null> {
  return loadMsgTemplate(ctx.tx, await templateGroupFor(ctx.tx, deptId, ctx.cfg), code);
}

/** Primo passaggio: $msg = $obj->replaceVars($tpl->asArray(), $vars). */
export function replaceAlertVars(tpl: AlertMessage, vars: Record<string, unknown>): AlertMessage {
  const r = new VariableReplacer().assign(vars);
  return { subj: r.replaceVars(tpl.subj), body: r.replaceVars(tpl.body) };
}

type AlertThread = { entryId: number; threadId: number } | undefined;

/**
 * Ciclo di invio: per ogni destinatario disponibile, con indirizzo non ancora avvisato e non escluso da
 * `skip`, secondo passaggio con `vars` + `recipient` (l'agente) e invio come avviso. Restituisce gli
 * indirizzi avvisati ($sentlist).
 */
export async function sendStaffAlerts(
  ctx: WriteContext,
  opts: {
    email: SystemEmail;
    /** messaggio dopo il primo passaggio */
    msg: AlertMessage;
    /** variabili del secondo passaggio, oltre a `recipient` */
    vars: Record<string, unknown>;
    recipients: number[];
    skip?: (staff: Agent) => Promise<boolean> | boolean;
    thread?: AlertThread;
  },
): Promise<string[]> {
  const { tx, cfg } = ctx;
  const { email, msg, thread } = opts;
  const sent: string[] = [];
  for (const id of opts.recipients) {
    const staff = await loadAgent(id, tx);
    if (!staff || !staff.isAvailable || sent.includes(staff.email)) continue;
    if (opts.skip && (await opts.skip(staff))) continue;
    const info = await loadStaffInfo(tx, staff.id);
    const r = new VariableReplacer().assign({ ...opts.vars, recipient: info ? staffVar(info, cfg) : null });
    const subject = r.replaceVars(msg.subj);
    const body = r.replaceVars(msg.body);
    const to = { name: new PersonsName({ first: staff.name.first, last: staff.name.last }, cfg.str("agent_name_format")).toString(), address: staff.email };
    ctx.after.push(async () => {
      await sendMail({ email, to: [to], subject, body, recipient: { userId: staff.id, utype: "S" }, thread, notice: true });
    });
    sent.push(staff.email);
  }
  return sent;
}

/** Avviso all'amministratore (admin_email) con `recipient` = "Admin"; le condizioni sono del chiamante. */
export function sendAdminAlert(
  ctx: WriteContext,
  opts: { email: SystemEmail; msg: AlertMessage; vars: Record<string, unknown>; utype: RecipientClass; thread?: AlertThread },
): void {
  const { email, thread, utype } = opts;
  const address = ctx.cfg.str("admin_email");
  const r = new VariableReplacer().assign({ ...opts.vars, recipient: "Admin" });
  const subject = r.replaceVars(opts.msg.subj);
  const body = r.replaceVars(opts.msg.body);
  ctx.after.push(async () => {
    await sendMail({ email, to: [{ name: "", address }], subject, body, recipient: { userId: 0, utype }, thread, notice: true });
  });
}
