import "server-only";

import { Team } from "@/lib/osticket/flags";

import { teamAlertMembers } from "../staff-alerts";
import { loadAgent, type Agent } from "../staff/staff";
import { taskThreadId } from "../thread/ids";
import type { WriteContext } from "../ticket/context";
import {
  agentName,
  assignableAgents,
  agentsNameJson,
  deptCanAssign,
  loadTeam,
  logTaskEvent,
  updateTaskRow,
  type TaskDbRow,
} from "./model";
import { taskVar, threadEntryVar } from "./vars";
import { isOpen, type TaskResult } from "./common";
import { deptAlertEmail, deptMembersForAlerts, sendTaskAlerts, staffTemplateVar } from "./alerts";
import { postTaskNote } from "./posts";

/** Assegnazione, presa in carico e trasferimento dei task (Task::assign, claim, transfer) con gli avvisi relativi. */

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
