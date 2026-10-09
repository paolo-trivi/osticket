import "server-only";

import { sql } from "kysely";
import { DateTime } from "luxon";

import { NOW, table, type DbOrTx } from "../../db";
import { phpJsonDecode } from "../../format/php-json";
import { slaDueDate } from "../sla/sla";
import { loadAgent, TicketPerm, type Agent, type RoleInfo } from "../staff/staff";
import type { WriteContext } from "./context";
import { logTicketEvent } from "./events";
import { SQL_NOW, type TicketColumns, type TicketRecord } from "./record";

/** Flag di Dept (include/class.dept.php) e Topic usati nelle scritture. */
export const DeptFlag = {
  ASSIGN_MEMBERS_ONLY: 0x0001,
  DISABLE_AUTO_CLAIM: 0x0002,
  ACTIVE: 0x0004,
  ARCHIVED: 0x0008,
  ASSIGN_PRIMARY_ONLY: 0x0010,
  DISABLE_REOPEN_AUTO_ASSIGN: 0x0020,
} as const;
/** Topic::FLAG_* (include/class.topic.php: CUSTOM_NUMBERS 0x1, ACTIVE 0x2, ARCHIVED 0x4) */
const TopicFlag = { ACTIVE: 0x0002, ARCHIVED: 0x0004 } as const;

export interface StatusRow {
  id: number;
  name: string;
  state: string;
  mode: number;
  properties: string | null;
}

/** TicketStatus::ENABLED (include/class.list.php: bit 0x1 di ticket_status.mode) */
export const STATUS_ENABLED = 0x0001;

export async function loadStatus(executor: DbOrTx, id: number): Promise<StatusRow | null> {
  const r = await executor.selectFrom("ticket_status").select(["id", "name", "state", "mode", "properties"]).where("id", "=", id).executeTakeFirst();
  return r ? { ...r, state: r.state ?? "", mode: Number(r.mode ?? 0) } : null;
}

/**
 * Stato sceglibile da un agente nei form (risposta, nota, menu "Cambia stato", azione di massa, nuovo
 * ticket): solo stati **abilitati** con stato open o closed, come le select del PHP
 * (`TicketStatusList::getStatuses(['states' => …])` + `isEnabled()`, ticket-view.inc.php e
 * status-options.tmpl.php). Il PHP lato server invece accetta qualsiasi `status_id` (TicketStatus::lookup):
 * con una richiesta costruita a mano un agente poteva impostare uno stato che l'amministratore ha
 * disabilitato. Gli stati "archived" li rifiuta già Ticket::setStatus. Differenza voluta (permessi): doc 17 §3.
 */
export function isSelectableStatus(status: StatusRow | null): status is StatusRow {
  return !!status && (status.mode & STATUS_ENABLED) !== 0 && (status.state === "open" || status.state === "closed");
}

export async function stateOf(executor: DbOrTx, row: TicketColumns): Promise<string> {
  return (await loadStatus(executor, row.status_id))?.state ?? "";
}

/** Ticket::isAssigned($staff) su una riga ticket */
function isAssignedRow(row: TicketColumns, state: string, agent: Agent): boolean {
  if (state !== "open") return false;
  return row.staff_id === agent.id || agent.isTeamMember(row.team_id);
}

/** Ticket::getRole($staff) */
export function roleOnRow(row: TicketColumns, state: string, agent: Agent): RoleInfo {
  return agent.roleFor(row.dept_id, isAssignedRow(row, state, agent));
}

/** TicketStatus::isReopenable */
export function statusIsReopenable(s: StatusRow): boolean {
  if (s.state.toLowerCase() !== "closed") return true;
  const p = phpJsonDecode<Record<string, unknown>>(s.properties, {});
  return !!p.allowreopen && "reopenstatus" in p;
}

/** Ticket::isReopenable: stato riapribile, reparto e help topic non archiviati. */
export async function ticketIsReopenable(executor: DbOrTx, row: TicketColumns, status: StatusRow): Promise<boolean> {
  if (!statusIsReopenable(status)) return false;
  const dept = await executor.selectFrom("department").select("flags").where("id", "=", row.dept_id).executeTakeFirst();
  if (dept && dept.flags & DeptFlag.ARCHIVED) return false;
  if (row.topic_id) {
    const topic = await executor.selectFrom("help_topic").select("flags").where("topic_id", "=", row.topic_id).executeTakeFirst();
    if (topic && (topic.flags ?? 0) & TopicFlag.ARCHIVED) return false;
  }
  return true;
}

/** Data DB nel passato? (Misc::db2gmtime($d) <= Misc::gmtime()) */
function dbDateIsPast(value: string | null, dbZone: string): boolean {
  if (!value || value.startsWith("0000")) return false;
  const dt = DateTime.fromSQL(value, { zone: dbZone });
  return dt.isValid && dt.toMillis() <= Date.now();
}

/** Ticket::clearOverdue($save=false) */
function clearOverdue(rec: TicketRecord, dbZone: string): void {
  if (rec.get("isoverdue")) rec.set("isoverdue", 0);
  if (rec.get("duedate") && dbDateIsPast(rec.get("duedate"), dbZone)) rec.set("duedate", null);
  // getSLADueDate() senza ricalcolo: se est_duedate è vuota il PHP la calcola ma assegnare null non cambia nulla
  if (rec.get("est_duedate") && dbDateIsPast(rec.get("est_duedate"), dbZone)) rec.set("est_duedate", null);
}

/** Ticket::updateEstDueDate */
export async function updateEstDueDate(ctx: WriteContext, rec: TicketRecord, clear = true): Promise<void> {
  if (rec.get("isoverdue") && clear) clearOverdue(rec, ctx.dbZone);
  const due = await slaDueDate({ slaId: rec.get("sla_id"), deptId: rec.get("dept_id"), start: rec.get("reopened") || rec.get("created") }, ctx.tx);
  rec.set("est_duedate", due ?? null);
  await rec.save();
}

/** Ticket::getNumOpenTasks */
async function numOpenTasks(executor: DbOrTx, ticketId: number): Promise<number> {
  const { rows } = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM ${table("task")}
    WHERE object_type = 'T' AND object_id = ${ticketId} AND (flags & 1) != 0`.execute(executor);
  return Number(rows[0]?.n ?? 0);
}

/** Ticket::getMissingRequiredFields: risposte vuote di campi "obbligatori in chiusura" non disabilitati dal topic. */
async function missingRequiredFields(executor: DbOrTx, row: TicketColumns): Promise<number> {
  const disabled: number[] = [];
  const forms = row.topic_id
    ? await executor.selectFrom("help_topic_form").select("extra").where("topic_id", "=", row.topic_id).execute()
    : await executor.selectFrom("form_entry").select("extra").where("object_type", "=", "T").where("object_id", "=", row.ticket_id).execute();
  for (const f of forms) {
    const extra = phpJsonDecode<{ disable?: number[] }>(f.extra, {});
    if (Array.isArray(extra.disable)) disabled.push(...extra.disable.map(Number));
  }
  // DynamicFormField::FLAG_CLOSE_REQUIRED = 0x0004, solo campi abilitati (FLAG_ENABLED = 0x0001).
  // Differenza voluta: nel PHP l'array di criteri `flags__hasbit` sovrascrive FLAG_ENABLED, quindi un campo
  // disabilitato ma "obbligatorio in chiusura" (che l'agente non può più compilare) bloccava per sempre la chiusura.
  const { rows } = await sql<{ n: number }>`SELECT COUNT(DISTINCT V.field_id) AS n FROM ${table("form_entry")} E
    JOIN ${table("form_entry_values")} V ON (V.entry_id = E.id)
    JOIN ${table("form_field")} F ON (F.id = V.field_id)
    WHERE E.object_type = 'T' AND E.object_id = ${row.ticket_id} AND (F.flags & ${0x0004}) != 0 AND (F.flags & ${0x0001}) != 0
      AND V.value IS NULL
    ${disabled.length ? sql`AND V.field_id NOT IN (${sql.join(disabled)})` : sql``}`.execute(executor);
  return Number(rows[0]?.n ?? 0);
}

/** Ticket::isCloseable */
export async function isCloseable(ctx: WriteContext, rec: TicketRecord, currentState: string): Promise<true | string> {
  if (currentState === "closed") return true;
  if (await missingRequiredFields(ctx.tx, rec.row)) return "This ticket is missing data on  one or more required fields  and cannot be closed";
  const n = await numOpenTasks(ctx.tx, rec.id);
  if (n) return `This ticket has ${n} open tasks and cannot be closed`;
  if (ctx.cfg.bool("require_topic_to_close") && !rec.get("topic_id")) return "This ticket is missing a Help Topic and cannot be closed";
  return true;
}

/** Ticket::deleteDrafts → Draft::deleteForNamespace('ticket.%.<id>') con la stessa (strana) LIKE del PHP. */
export async function deleteTicketDrafts(executor: DbOrTx, ticketId: number): Promise<void> {
  const ns = `ticket.%.${ticketId}`;
  // startswith: la % del namespace viene escapata (corrisponde solo a un '%' letterale)
  await sql`DELETE A FROM ${table("attachment")} A JOIN ${table("draft")} D ON (A.type = 'D' AND A.object_id = D.id)
    WHERE D.namespace LIKE ${ns.replace(/([%_\\])/g, "\\$1") + "%"}`.execute(executor);
  await executor.deleteFrom("draft").where("namespace", "like", ns).execute();
}

/** Thread::refer($staff): referral all'agente se non già presente (controllo stretto). */
async function referThreadToStaff(executor: DbOrTx, threadId: number, staffId: number): Promise<boolean> {
  const exists = await executor
    .selectFrom("thread_referral")
    .select("id")
    .where("thread_id", "=", threadId)
    .where("object_type", "=", "S")
    .where("object_id", "=", staffId)
    .executeTakeFirst();
  if (exists) return false;
  await executor.insertInto("thread_referral").values({ thread_id: threadId, object_id: staffId, object_type: "S", created: NOW }).execute();
  return true;
}

/** Ticket::getLastRespondent: penultima risposta di un agente (limit '1,1' nel PHP). */
export async function lastRespondentId(executor: DbOrTx, threadId: number): Promise<number> {
  const { rows } = await sql<{ staff_id: number }>`SELECT staff_id FROM ${table("thread_entry")}
    WHERE thread_id = ${threadId} AND type = 'R' AND staff_id > 0 ORDER BY id DESC LIMIT 1, 1`.execute(executor);
  if (!rows[0]) return 0;
  const s = await executor.selectFrom("staff").select("staff_id").where("staff_id", "=", rows[0].staff_id).executeTakeFirst();
  return s?.staff_id ?? 0;
}

/** Ticket::setStaffId: assegnazione diretta, salvataggio immediato. */
async function setStaffId(rec: TicketRecord, staffId: number): Promise<void> {
  rec.set("staff_id", staffId);
  await rec.save();
}

interface SetStatusOptions {
  comments?: string;
  setClosingAgent?: boolean;
  forceClose?: boolean;
  /** nota "Status Changed" quando ci sono commenti (iniettata per evitare dipendenze circolari) */
  logNote?: (title: string, body: string) => Promise<void>;
  /** Ticket::delete per lo stato "deleted" */
  hardDelete?: () => Promise<boolean>;
}

/**
 * Ticket::setStatus (include/class.ticket.php:1483). Restituisce true o un messaggio d'errore/false.
 */
export async function setTicketStatus(
  ctx: WriteContext,
  rec: TicketRecord,
  threadId: number,
  statusId: number,
  opts: SetStatusOptions = {},
): Promise<true | false | string> {
  const { tx, cfg, agent } = ctx;
  const setClosingAgent = opts.setClosingAgent ?? true;
  const current = rec.get("status_id") ? await loadStatus(tx, rec.get("status_id")) : null;
  const currentState = current?.state ?? "";
  const role = agent ? roleOnRow(rec.row, currentState, agent) : null;

  const status = await loadStatus(tx, statusId);
  if (!status) return false;

  if (role && rec.get("status_id")) {
    if (status.state === "closed" && !role.perms.has(TicketPerm.CLOSE)) return false;
    if (status.state === "deleted") {
      if (role.perms.has(TicketPerm.DELETE) && opts.hardDelete) return opts.hardDelete();
      return false;
    }
  }

  const hadStatus = rec.get("status_id");
  if (rec.get("status_id") === status.id) return true;

  let referStaffId = 0;
  let ecb: (() => Promise<void>) | null = null;
  switch (status.state) {
    case "closed": {
      const closeable = opts.forceClose ? true : await isCloseable(ctx, rec, currentState);
      if (closeable !== true) return closeable || "This ticket cannot be closed";
      referStaffId = rec.get("staff_id") || (agent?.id ?? 0);
      rec.set("closed", SQL_NOW as never);
      rec.set("lastupdate", SQL_NOW as never);
      if (agent && setClosingAgent) rec.set("staff_id", agent.id);
      clearOverdue(rec, ctx.dbZone);
      ecb = async () => {
        await logTicketEvent(tx, rec.row, threadId, ctx.actor, "closed", { status: [status.id, status.name] }, undefined, "closed");
        await deleteTicketDrafts(tx, rec.id);
      };
      break;
    }
    case "open": {
      const isClosed = currentState === "closed";
      if (isClosed && current && (await ticketIsReopenable(tx, rec.row, current))) {
        const dept = await tx.selectFrom("department").select(["id", "flags"]).where("id", "=", rec.get("dept_id")).executeTakeFirst();
        const candidate = rec.get("staff_id") || (await lastRespondentId(tx, threadId));
        const autoassign = !(dept && dept.flags & DeptFlag.DISABLE_REOPEN_AUTO_ASSIGN);
        let assignee = 0;
        if (autoassign && candidate) {
          const staff = await loadAgent(candidate, tx);
          if (staff && staff.isAvailable && staff.canAccessDept(rec.get("dept_id"))) assignee = staff.id;
        }
        await setStaffId(rec, assignee);
      }
      if (isClosed) {
        rec.set("closed", null);
        rec.set("lastupdate", SQL_NOW as never);
        rec.set("reopened", SQL_NOW as never);
        ecb = async () => {
          await logTicketEvent(tx, rec.row, threadId, ctx.actor, "reopened", null, undefined, "closed");
          await updateEstDueDate(ctx, rec);
        };
      }
      if (currentState !== "open") rec.set("isanswered", 0);
      break;
    }
    default:
      return false;
  }

  rec.set("status_id", status.id);
  await rec.save(true);

  if (referStaffId && cfg.bool("auto_refer_closed")) await referThreadToStaff(tx, threadId, referStaffId);

  if (hadStatus && opts.comments && opts.logNote) {
    const clean = opts.comments.replace(/^[\s<>br/]+|[\s<>br/]+$/g, "") ? opts.comments : "";
    if (clean) await opts.logNote("Status Changed", clean);
  }

  if (ecb) await ecb();
  else if (hadStatus) await logTicketEvent(tx, rec.row, threadId, ctx.actor, "edited", { status: status.id });
  return true;
}
