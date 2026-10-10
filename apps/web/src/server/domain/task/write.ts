import "server-only";

import { sql } from "kysely";
import { DateTime } from "luxon";

import { Dept, DynamicFormField, TaskModel, Team, ThreadEntry } from "@/lib/osticket/flags";
import { ObjectType, ThreadEntryType } from "@/lib/osticket/object-types";

import { NOW, table, type DbOrTx } from "../../db";
import type { SystemEmail } from "../../mail/mailer";
import { companyVar, loadStaffInfo, staffVar } from "../../mail/objects";
import type { TemplateCode } from "../../mail/templates";
import type { TemplateVariable } from "../../mail/variables";
import { logSystem } from "../../system/syslog";
import { alertOrDefaultEmail } from "../directory/content-mail";
import { defaultFormOf, createEntry, deleteEntries, entriesFor, saveEntryAnswers, validateInput } from "../forms/answers";
import { currentTimezone } from "../forms/entry";
import { hasAnswerRow, isEditableToStaff } from "../forms/fields";
import { deleteDraftsForNamespace } from "../drafts";
import { deleteSearchRow } from "../search/index-writer";
import { nextSequenceNumber } from "../sequence";
import {
  deptAlertEmail as deptEmailOf,
  deptAlertMembers,
  deptMsgTemplate,
  replaceAlertVars,
  sendAdminAlert,
  sendStaffAlerts,
  teamAlertMembers,
} from "../staff-alerts";
import { loadAgent, TaskPerm, type Agent } from "../staff/staff";
import { taskThreadId, ticketThreadId } from "../thread/ids";
import { createThreadEntry, lastMessage, touchThread } from "../thread/write";
import type { WriteContext } from "../ticket/context";
import { logNote } from "../ticket/post";
import { TicketRecord } from "../ticket/record";
import { reopenTicket } from "../ticket/ticket-state";
import {
  agentName,
  assignableAgents,
  agentsNameJson,
  deptCanAssign,
  loadTaskRow,
  loadTeam,
  logTaskEvent,
  updateTaskRow,
  type TaskDbRow,
} from "./model";
import { checkTaskPerm, loadTask } from "./tasks";
import { activityVar, taskVar, threadEntryVar } from "./vars";

/**
 * Scritture sui task (include/class.task.php, include/ajax.tasks.php, scp/tasks.php) con le stesse righe
 * del PHP: task, task__cdata, form_entry(_values), thread 'A', thread_entry, thread_event, sequence,
 * _search, avvisi email (task.alert, task.activity.alert, task.assignment.alert, task.transfer.alert).
 */
export type TaskError =
  | "not_found" | "forbidden" | "note_required" | "response_required" | "title_required" | "dept_required"
  | "already_assigned" | "unavailable" | "unknown_assignee" | "team_disabled" | "team_empty" | "same_dept"
  | "not_closeable" | "no_change" | "due_past" | "invalid_date" | "already_status";

export type TaskResult<T = object> = ({ ok: true } & T) | { ok: false; error: TaskError };

const isOpen = (t: TaskDbRow) => (t.flags & TaskModel.ISOPEN) !== 0;

function bodyFormat(ctx: WriteContext): "html" | "text" {
  return ctx.cfg.bool("enable_richtext") ? "html" : "text";
}

/* ------------------------------------------------------------------ numerazione */

/** $cfg->getNewTaskNumber(): sequenza task_sequence_id (RandomSequence se assente) con Task::isNumberUnique. */
async function nextTaskNumber(ctx: WriteContext): Promise<string> {
  const { tx, cfg } = ctx;
  return nextSequenceNumber(tx, cfg.int("task_sequence_id"), cfg.str("task_number_format"), async (n) => {
    const dup = await tx.selectFrom("task").select("id").where("number", "=", n).executeTakeFirst();
    return !dup;
  });
}

/* ------------------------------------------------------------------ avvisi */

/**
 * Invio di un avviso del task (Task::replaceVars): primo passaggio con le variabili dell'operazione, il
 * secondo con le stesse variabili più il destinatario; avviso all'amministratore facoltativo.
 */
async function sendTaskAlerts(
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
async function deptAlertEmail(ctx: WriteContext, deptId: number): Promise<SystemEmail | null> {
  const d = await ctx.tx.selectFrom("department").select("email_id").where("id", "=", deptId).executeTakeFirst();
  return deptEmailOf(ctx.tx, ctx.cfg, d?.email_id);
}

/** Dept::getMembersForAlerts() del reparto indicato */
async function deptMembersForAlerts(ctx: WriteContext, deptId: number): Promise<number[]> {
  const d = await ctx.tx.selectFrom("department").select(["id", "manager_id", "group_membership"]).where("id", "=", deptId).executeTakeFirst();
  return d ? deptAlertMembers(ctx.tx, d, ctx.cfg.str("agent_name_format")) : [];
}

async function staffTemplateVar(ctx: WriteContext, staffId: number): Promise<TemplateVariable | null> {
  const info = await loadStaffInfo(ctx.tx, staffId);
  return info ? staffVar(info, ctx.cfg) : null;
}

/** Task::onActivity: avviso task.activity.alert */
async function onActivity(
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
async function onNewTask(ctx: WriteContext, task: TaskDbRow): Promise<void> {
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

/* ------------------------------------------------------------------ note e risposte */

interface TaskNoteInput {
  note: string;
  title?: string;
  /** cambio di stato insieme alla nota (task:status) */
  status?: "open" | "closed";
  alert?: boolean;
}

/** Task::postNote. `poster`: agente (default l'agente corrente), stringa, o null = SYSTEM. */
export async function postTaskNote(
  ctx: WriteContext,
  task: TaskDbRow,
  input: TaskNoteInput,
  poster: Agent | string | null | undefined = ctx.agent,
): Promise<TaskResult<{ entryId: number }>> {
  const { tx, cfg } = ctx;
  if (!input.note || !input.note.trim()) return { ok: false, error: "note_required" };
  const threadId = await taskThreadId(tx, task.id);
  if (!threadId) return { ok: false, error: "not_found" };
  const staffId = poster && typeof poster === "object" ? poster.id : 0;
  const posterName = poster && typeof poster === "object" ? agentName(poster, cfg) : poster || "SYSTEM";
  const entry = await createThreadEntry(tx, cfg, {
    threadId,
    type: ThreadEntryType.NOTE,
    body: input.note,
    format: bodyFormat(ctx),
    title: input.title ?? "",
    staffId,
    userId: 0,
    poster: posterName,
  });
  const assigneeId = task.staff_id;
  if (input.status) await setTaskStatus(ctx, task, input.status);
  await onActivity(ctx, task, threadId, { id: entry.id, staffId }, ["New Internal Note", "New internal note posted"], assigneeId, input.alert ?? true);
  return { ok: true, entryId: entry.id };
}

/** Task::postReply (aggiornamento del task da parte di un agente). */
export async function postTaskReply(ctx: WriteContext, task: TaskDbRow, input: { response: string; status?: "open" | "closed" }): Promise<TaskResult<{ entryId: number }>> {
  const { tx, cfg, agent } = ctx;
  if (!agent) return { ok: false, error: "forbidden" };
  if (!input.response || !input.response.trim()) return { ok: false, error: "response_required" };
  const threadId = await taskThreadId(tx, task.id);
  const last = await lastMessage(tx, threadId);
  const entry = await createThreadEntry(tx, cfg, {
    threadId,
    type: ThreadEntryType.RESPONSE,
    body: input.response,
    format: bodyFormat(ctx),
    staffId: agent.id,
    userId: 0,
    poster: agentName(agent, cfg),
    pid: last?.id,
    ip: ctx.actor?.ip ?? "",
    flags: 0,
  });
  await touchThread(tx, threadId, "lastresponse");
  const assigneeId = task.staff_id;
  if (input.status) await setTaskStatus(ctx, task, input.status);
  await onActivity(ctx, task, threadId, { id: entry.id, staffId: agent.id }, ["New Response", "New response posted"], assigneeId);
  return { ok: true, entryId: entry.id };
}

/* ------------------------------------------------------------------ stato */

/** $task->ticket->reopen(): Ticket::reopen di ticket-state (TicketStatus::getReopenStatus o stato predefinito). */
async function reopenParentTicket(ctx: WriteContext, ticketId: number): Promise<void> {
  const rec = await TicketRecord.load(ctx.tx, ticketId, true);
  if (!rec) return;
  await reopenTicket(ctx, rec, await ticketThreadId(ctx.tx, rec.id));
}

/** Campi del form del task obbligatori per la chiusura e senza valore (Task::getMissingRequiredFields). */
export async function missingRequiredFields(executor: DbOrTx, taskId: number): Promise<number> {
  const { rows } = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM ${table("form_entry")} E
    JOIN ${table("form_entry_values")} V ON (V.entry_id = E.id)
    JOIN ${table("form_field")} F ON (F.id = V.field_id)
    WHERE E.object_type = 'A' AND E.object_id = ${taskId} AND (F.flags & ${DynamicFormField.CLOSE_REQUIRED}) != 0 AND V.value IS NULL`.execute(executor);
  return Number(rows[0]?.n ?? 0);
}

/** Task::setStatus($status, $comments) */
export async function setTaskStatus(ctx: WriteContext, task: TaskDbRow, status: "open" | "closed", comments = ""): Promise<TaskResult> {
  const { tx } = ctx;
  const threadId = await taskThreadId(tx, task.id);
  let ecb: () => Promise<void>;
  if (status === "open") {
    if (isOpen(task)) return { ok: false, error: "already_status" };
    await updateTaskRow(tx, task, { flags: task.flags | TaskModel.ISOPEN, ...(task.closed !== null ? { closed: null } : {}) });
    ecb = async () => {
      await logTaskEvent(ctx, task, threadId, "reopened", null, undefined, "closed");
      if (task.object_type === ObjectType.TICKET && task.object_id) {
        await reopenParentTicket(ctx, task.object_id);
        await logNote(ctx, task.object_id, `Task ${task.number} Reopened`, "Task reopened");
      }
    };
  } else {
    if (!isOpen(task)) return { ok: false, error: "already_status" };
    if (await missingRequiredFields(tx, task.id)) return { ok: false, error: "not_closeable" };
    await updateTaskRow(tx, task, { flags: task.flags & ~TaskModel.ISOPEN, closed: "NOW" });
    ecb = async () => {
      await logTaskEvent(ctx, task, threadId, "closed");
      if (task.object_type === ObjectType.TICKET && task.object_id) await logNote(ctx, task.object_id, `Task ${task.number} Closed`, "Task closed");
    };
  }
  await ecb();
  if (comments && comments.trim()) {
    await postTaskNote(ctx, task, { note: comments, title: `Status changed to ${isOpen(task) ? "Open" : "Completed"}` });
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ assegnazione */

export type TaskAssignee = { type: "staff"; id: number } | { type: "team"; id: number };

async function onAssignment(ctx: WriteContext, task: TaskDbRow, assignee: { staff?: Agent; team?: { team_id: number; name: string; flags: number; lead_id: number } }, comments: string, alert: boolean): Promise<void> {
  const { tx, cfg, agent } = ctx;
  const assignerName = agent ? agent : "SYSTEM (Auto Assignment)";
  const assigneeName = assignee.staff ? agentName(assignee.staff, cfg) : (assignee.team?.name ?? "");
  let noteId = 0;
  if (comments) {
    const r = await postTaskNote(ctx, task, { note: comments, title: `Task assigned to ${assigneeName}`, alert: false }, assignerName);
    if (r.ok) noteId = r.entryId;
  }
  if (!alert || !cfg.bool("task_assignment_alert_active")) return;
  const email = await deptAlertEmail(ctx, task.dept_id);
  const recipients: number[] = [];
  if (assignee.staff) {
    if (cfg.bool("task_assignment_alert_staff")) recipients.push(assignee.staff.id);
  } else if (assignee.team && !(assignee.team.flags & Team.NOALERTS)) {
    const members = await teamAlertMembers(tx, assignee.team.team_id);
    if (cfg.bool("task_assignment_alert_team_members") && members.length) recipients.push(...members);
    else if (cfg.bool("task_assignment_alert_team_lead") && assignee.team.lead_id) recipients.push(assignee.team.lead_id);
  }
  if (!recipients.length) return;
  const threadId = await taskThreadId(tx, task.id);
  const assigneeVar = assignee.staff
    ? await staffTemplateVar(ctx, assignee.staff.id)
    : { getVar: (t: string) => (t === "name" ? assignee.team!.name : t === "id" ? assignee.team!.team_id : ""), asVar: () => assignee.team!.name };
  await sendTaskAlerts(ctx, {
    email,
    code: "task.assignment.alert",
    deptId: task.dept_id,
    recipients,
    vars: {
      task: await taskVar(tx, task, cfg, ctx.dbZone),
      comments,
      assignee: assigneeVar,
      assigner: agent ? await staffTemplateVar(ctx, agent.id) : assignerName,
    },
    thread: noteId ? { entryId: noteId, threadId } : undefined,
  });
}

/** Task::assign(AssignmentForm) con le validazioni di AssignmentForm::isValid. */
export async function assignTask(ctx: WriteContext, task: TaskDbRow, to: TaskAssignee, comments = "", alert = true): Promise<TaskResult> {
  const { tx, cfg, agent } = ctx;
  const threadId = await taskThreadId(tx, task.id);
  if (to.type === "staff") {
    const staff = await loadAgent(to.id, tx);
    if (!staff) return { ok: false, error: "unknown_assignee" };
    if (!staff.isAvailable) return { ok: false, error: "unavailable" };
    // AssignmentForm::isValid: l'agente deve essere tra le scelte del campo (Dept::getAssignees + visibilità)
    if (!(await assignableAgents(tx, task.dept_id, agent, cfg)).some((a) => a.id === staff.id)) return { ok: false, error: "unknown_assignee" };
    if (task.staff_id === staff.id) return { ok: false, error: "already_assigned" };
    if (!(await deptCanAssign(tx, task.dept_id, staff, cfg))) return { ok: false, error: "forbidden" };
    const evd: Record<string, unknown> =
      agent && agent.id === staff.id ? { claim: true } : { staff: [staff.id, agentsNameJson(staff.name.first, staff.name.last, cfg)] };
    await updateTaskRow(tx, task, { staff_id: staff.id });
    await logTaskEvent(ctx, task, threadId, "assigned", evd);
    await onAssignment(ctx, task, { staff }, comments, alert);
    return { ok: true };
  }
  const team = await loadTeam(tx, to.id);
  if (!team) return { ok: false, error: "unknown_assignee" };
  if (!(team.flags & Team.ENABLED)) return { ok: false, error: "team_disabled" };
  if (!team.members) return { ok: false, error: "team_empty" };
  if (task.team_id === team.team_id) return { ok: false, error: "already_assigned" };
  await updateTaskRow(tx, task, { team_id: team.team_id });
  await logTaskEvent(ctx, task, threadId, "assigned", { team: team.team_id });
  await onAssignment(ctx, task, { team }, comments, alert);
  return { ok: true };
}

/** Task::claim → assignToStaff($thisstaff, $comments, false) */
export async function claimTask(ctx: WriteContext, task: TaskDbRow, comments = ""): Promise<TaskResult> {
  const { tx, cfg, agent } = ctx;
  if (!agent) return { ok: false, error: "unknown_assignee" };
  if (!agent.isAvailable) return { ok: false, error: "unavailable" };
  if (!(await deptCanAssign(tx, task.dept_id, agent, cfg))) return { ok: false, error: "forbidden" };
  const threadId = await taskThreadId(tx, task.id);
  if (task.staff_id !== agent.id) await updateTaskRow(tx, task, { staff_id: agent.id });
  await onAssignment(ctx, task, { staff: agent }, comments, false);
  await logTaskEvent(ctx, task, threadId, "assigned", { claim: true });
  return { ok: true };
}

/** Task::transfer(TransferForm) */
export async function transferTask(ctx: WriteContext, task: TaskDbRow, deptId: number, comments = "", alert = true): Promise<TaskResult> {
  const { tx, cfg, agent } = ctx;
  const dept = await tx.selectFrom("department").select(["id", "name", "manager_id", "flags"]).where("id", "=", deptId).executeTakeFirst();
  if (!dept) return { ok: false, error: "dept_required" };
  if (dept.id === task.dept_id) return { ok: false, error: "same_dept" };
  const from = await tx.selectFrom("department").select("name").where("id", "=", task.dept_id).executeTakeFirst();
  const threadId = await taskThreadId(tx, task.id);
  await updateTaskRow(tx, task, { dept_id: dept.id });
  await logTaskEvent(ctx, task, threadId, "transferred", { dept: dept.name });
  let noteId = 0;
  if (comments) {
    const r = await postTaskNote(ctx, task, { note: comments, title: `Task transferred from ${from?.name ?? ""} to ${dept.name}`, alert: false });
    if (r.ok) noteId = r.entryId;
  }
  if (!alert || !cfg.bool("task_transfer_alert_active")) return { ok: true };
  const email = await deptAlertEmail(ctx, dept.id);
  const recipients: number[] = [];
  const assigned = isOpen(task) && !!(task.staff_id || task.team_id);
  if (assigned && cfg.bool("task_transfer_alert_assigned")) {
    if (task.staff_id) recipients.push(task.staff_id);
    else if (task.team_id) recipients.push(...(await teamAlertMembers(tx, task.team_id)));
  } else if (cfg.bool("task_transfer_alert_dept_members") && !assigned) {
    recipients.push(...(await deptMembersForAlerts(ctx, dept.id)));
  }
  if (cfg.bool("task_transfer_alert_dept_manager") && dept.manager_id) recipients.push(dept.manager_id);
  await sendTaskAlerts(ctx, {
    email,
    code: "task.transfer.alert",
    deptId: dept.id,
    recipients,
    vars: {
      task: await taskVar(tx, task, cfg, ctx.dbZone),
      // $note diventa la ThreadEntry della nota, se pubblicata
      comments: noteId ? await threadEntryVar(tx, noteId, cfg, ctx.dbZone) : comments,
      staff: agent ? await staffTemplateVar(ctx, agent.id) : null,
    },
    thread: noteId ? { entryId: noteId, threadId } : undefined,
  });
  return { ok: true };
}

/* ------------------------------------------------------------------ creazione */

interface NewTaskInput {
  title: string;
  description: string;
  deptId: number;
  assignee?: TaskAssignee | null;
  /** istante ISO 8601 (con fuso) o vuoto */
  duedate?: string | null;
  /** ticket collegato */
  ticketId?: number;
  /** altri campi del form del task (per nome) */
  fields?: Record<string, unknown>;
}

/** Converte un istante ISO nel formato del DB ('Y-m-d H:i:s' nel fuso del DB). */
function isoToDb(iso: string, dbZone: string): string | null {
  const dt = DateTime.fromISO(iso, { setZone: true });
  if (!dt.isValid) return null;
  return dt.setZone(dbZone).toFormat("yyyy-MM-dd HH:mm:ss");
}

/** Task::create (ajax.tasks.php:add, ajax.tickets.php:addTask) */
export async function createTask(ctx: WriteContext, input: NewTaskInput): Promise<TaskResult<{ id: number; number: string }>> {
  const { tx, cfg, agent } = ctx;
  if (!agent || !agent.hasPermInAnyRole(TaskPerm.CREATE)) return { ok: false, error: "forbidden" };
  const form = await defaultFormOf(tx, "A");
  if (!form) return { ok: false, error: "not_found" };
  const values: Record<string, unknown> = { ...(input.fields ?? {}), title: input.title, description: input.description };
  const timezone = await currentTimezone(ctx);
  const errors = await validateInput(form.fields, values, () => true, cfg, { timezone });
  if (errors.title) return { ok: false, error: "title_required" };
  if (!input.deptId) return { ok: false, error: "dept_required" };
  const dept = await tx.selectFrom("department").select("id").where("id", "=", input.deptId).executeTakeFirst();
  if (!dept) return { ok: false, error: "dept_required" };
  let duedate: string | null = null;
  if (input.duedate) {
    duedate = isoToDb(input.duedate, ctx.dbZone);
    if (!duedate) return { ok: false, error: "invalid_date" };
    if (DateTime.fromISO(input.duedate).toMillis() <= Date.now()) return { ok: false, error: "due_past" };
    duedate = duedate.slice(0, 16) + ":00"; // date('Y-m-d G:i'): niente secondi
  }
  if (input.assignee) {
    const a = input.assignee;
    if (a.type === "staff") {
      const s = await loadAgent(a.id, tx);
      if (!s || !s.isAvailable) return { ok: false, error: "unavailable" };
      // TaskInternalForm: AssigneeField senza reparto (Staff::getStaffMembers con visibilità)
      if (!(await assignableAgents(tx, null, agent, cfg)).some((x) => x.id === s.id)) return { ok: false, error: "unknown_assignee" };
    } else {
      const t = await loadTeam(tx, a.id);
      if (!t || !(t.flags & Team.ENABLED)) return { ok: false, error: "team_disabled" };
      if (!t.members) return { ok: false, error: "team_empty" };
    }
  }

  const number = await nextTaskNumber(ctx);
  const res = await tx
    .insertInto("task")
    .values({
      flags: TaskModel.ISOPEN,
      ...(input.ticketId ? { object_id: input.ticketId, object_type: ObjectType.TICKET } : { object_type: "" }),
      number,
      created: NOW,
      updated: NOW,
      dept_id: input.deptId,
      ...(duedate ? { duedate } : {}),
    })
    .executeTakeFirstOrThrow();
  const id = Number(res.insertId);
  const task = (await loadTaskRow(tx, id))!;

  // addDynamicData: entry del form "Task Details" con le risposte
  await createEntry(tx, form, "A", "A", id, values, { timezone });

  // TaskThread::create + addDescription (MessageThreadEntry con flag ORIGINAL_MESSAGE)
  const th = await tx.insertInto("thread").values({ object_id: id, object_type: ObjectType.TASK, created: NOW }).executeTakeFirstOrThrow();
  const threadId = Number(th.insertId);
  const entry = await createThreadEntry(tx, cfg, {
    threadId,
    type: ThreadEntryType.MESSAGE,
    body: input.description,
    format: bodyFormat(ctx),
    staffId: agent.id,
    userId: 0,
    poster: agentName(agent, cfg),
    ip: ctx.actor?.ip ?? "",
  });
  await tx.updateTable("thread_entry").set({ flags: entry.flags | ThreadEntry.ORIGINAL_MESSAGE }).where("id", "=", entry.id).execute();

  await logTaskEvent(ctx, task, threadId, "created", null, ctx.actor);

  if (input.assignee && agent.roleFor(task.dept_id).perms.has(TaskPerm.ASSIGN)) {
    await assignTask(ctx, task, input.assignee, "");
  }
  await onNewTask(ctx, task);
  return { ok: true, id, number };
}

/* ------------------------------------------------------------------ modifica */

/** Task::update($forms, $vars): campi del form, nota facoltativa, evento edited. */
export async function updateTaskFields(ctx: WriteContext, task: TaskDbRow, fields: Record<string, unknown>, note = ""): Promise<TaskResult> {
  const { tx } = ctx;
  const entries = await entriesFor(tx, "A", task.id);
  if (!entries.length) return { ok: false, error: "not_found" };
  const timezone = await currentTimezone(ctx);
  for (const e of entries) {
    const errors = await validateInput(e.fields, fields, (f) => isEditableToStaff(f), ctx.cfg, { timezone });
    if (Object.keys(errors).length) return { ok: false, error: "title_required" };
  }
  const changes: Record<string, [string | null, string | null]> = {};
  for (const e of entries) {
    const r = await saveEntryAnswers(tx, e, task.id, fields, { isEditable: (f) => isEditableToStaff(f) && hasAnswerRow(f), timezone });
    for (const [k, v] of Object.entries(r.changes)) if (!(k in changes)) changes[k] = v;
  }
  if (note && note.trim()) await postTaskNote(ctx, task, { note, title: "Task Updated" });
  const threadId = await taskThreadId(tx, task.id);
  if (Object.keys(changes).length) await logTaskEvent(ctx, task, threadId, "edited", { fields: changes });
  await updateTaskRow(tx, task, { updated: "NOW" });
  return { ok: true };
}

/** Task::updateField per la data di scadenza (ajax.tasks.php:editField 'duedate'). `iso` vuoto = rimozione. */
export async function updateTaskDueDate(ctx: WriteContext, task: TaskDbRow, iso: string | null, comments = ""): Promise<TaskResult> {
  const { tx } = ctx;
  let val: string | null = null;
  if (iso) {
    val = isoToDb(iso, ctx.dbZone);
    if (!val) return { ok: false, error: "invalid_date" };
  }
  // FormField::getChanges confronta il timestamp attuale con il valore inviato: "nessuna modifica" solo se entrambi vuoti
  if (!task.duedate && !val) return { ok: false, error: "no_change" };
  if (iso && DateTime.fromISO(iso).toMillis() <= Date.now()) return { ok: false, error: "due_past" };
  const threadId = await taskThreadId(tx, task.id);
  await updateTaskRow(tx, task, { duedate: val });
  await logTaskEvent(ctx, task, threadId, "edited", null);
  if (comments && comments.trim()) await postTaskNote(ctx, task, { note: comments, title: "Due Date updated", alert: false });
  await updateTaskRow(tx, task, { updated: "NOW" });
  return { ok: true };
}

/* ------------------------------------------------------------------ eliminazione */

/** Task::delete($comments): task, thread (voci, indice, collaboratori, referral), eventi, bozze, form. */
export async function deleteTask(ctx: WriteContext, task: TaskDbRow, comments = ""): Promise<TaskResult> {
  const { tx, agent, cfg } = ctx;
  const threadId = await taskThreadId(tx, task.id);
  await tx.deleteFrom("task").where("id", "=", task.id).execute();
  await deleteSearchRow(tx, "A", task.id);
  if (threadId) {
    await tx.deleteFrom("thread").where("id", "=", threadId).execute();
    await sql`DELETE s.* FROM ${table("_search")} s JOIN ${table("thread_entry")} h ON (h.id = s.object_id)
      WHERE s.object_type = 'H' AND h.thread_id = ${threadId}`.execute(tx);
    await sql`UPDATE ${table("thread_entry_email")} E JOIN ${table("thread_entry")} H ON (H.id = E.thread_entry_id)
      SET E.headers = NULL WHERE H.thread_id = ${threadId}`.execute(tx);
    await sql`DELETE A FROM ${table("attachment")} A JOIN ${table("thread_entry")} H ON (A.type = 'H' AND A.object_id = H.id)
      WHERE H.thread_id = ${threadId}`.execute(tx);
    await tx.deleteFrom("thread_collaborator").where("thread_id", "=", threadId).execute();
    await tx.deleteFrom("thread_referral").where("thread_id", "=", threadId).execute();
    await tx.deleteFrom("thread_entry").where("thread_id", "=", threadId).execute();
    await tx.updateTable("thread_event").set({ thread_id: 0 }).where("thread_id", "=", threadId).execute();
    await logTaskEvent(ctx, task, threadId, "deleted");
  }
  await deleteDraftsForNamespace(tx, `task.%.${task.id}`);
  await deleteEntries(tx, "A", task.id);
  let log = `Task #${task.number} deleted by ${agent ? agentName(agent, cfg) : "SYSTEM"}`;
  if (comments) log += `<hr>${comments}`;
  await logSystem("Debug", `Task #${task.number} deleted`, log, ctx.actor?.ip ?? "", { executor: tx });
  return { ok: true };
}

/* ------------------------------------------------------------------ azioni di massa */

export type TaskMassAction =
  | { action: "claim" }
  | { action: "assign"; to: TaskAssignee }
  | { action: "transfer"; deptId: number }
  | { action: "close"; comments?: string }
  | { action: "reopen"; comments?: string }
  | { action: "delete"; comments?: string };

/** ajax.tasks.php:massProcess: restituisce il numero di task elaborati. */
export async function massTaskAction(ctx: WriteContext, ids: number[], op: TaskMassAction): Promise<number> {
  const agent = ctx.agent;
  if (!agent) return 0;
  let done = 0;
  for (const id of ids) {
    const row = await loadTask(id, ctx.tx);
    const task = await loadTaskRow(ctx.tx, id, true);
    if (!row || !task) continue;
    let r: TaskResult | null = null;
    switch (op.action) {
      case "claim":
        if (checkTaskPerm(row, agent, TaskPerm.ASSIGN)) r = await claimTask(ctx, task, "");
        break;
      case "assign":
        if (checkTaskPerm(row, agent, TaskPerm.ASSIGN)) r = await assignTask(ctx, task, op.to, "");
        break;
      case "transfer":
        if (checkTaskPerm(row, agent, TaskPerm.TRANSFER)) r = await transferTask(ctx, task, op.deptId, "");
        break;
      case "close":
      case "reopen": {
        const perm = op.action === "close" ? TaskPerm.CLOSE : TaskPerm.CREATE;
        if (agent.hasPermInAnyRole(perm) && checkTaskPerm(row, agent, perm)) {
          r = await setTaskStatus(ctx, task, op.action === "close" ? "closed" : "open", op.comments ?? "");
        }
        break;
      }
      case "delete":
        if (checkTaskPerm(row, agent, TaskPerm.DELETE)) r = await deleteTask(ctx, task, op.comments ?? "");
        break;
    }
    if (r?.ok) done++;
  }
  return done;
}
