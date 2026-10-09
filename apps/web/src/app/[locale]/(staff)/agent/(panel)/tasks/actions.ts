"use server";

import { getLocale } from "next-intl/server";
import { revalidatePath } from "next/cache";

import { redirect } from "@/i18n/navigation";
import type { PeopleActionState } from "@/components/people/types";
import { formHtml, formIds, formNum, formStr } from "@/server/actions/form-data";
import { nonce } from "@/server/actions/result";
import { clientIp } from "@/server/auth/session";
import { currentAgent } from "@/server/auth/staff-auth";
import { db } from "@/server/db";
import { TaskPerm, type Agent } from "@/server/domain/staff/staff";
import { loadTaskRow, type TaskDbRow } from "@/server/domain/task/model";
import { checkTaskPerm, loadTask, TaskFlag, type TaskRow } from "@/server/domain/task/tasks";
import {
  assignTask,
  claimTask,
  createTask,
  deleteTask,
  massTaskAction,
  postTaskNote,
  postTaskReply,
  setTaskStatus,
  transferTask,
  updateTaskDueDate,
  updateTaskFields,
  type TaskMassAction,
  type TaskResult,
} from "@/server/domain/task/write";
import { deleteDraftsFor } from "@/server/domain/ticket/collab";
import type { WriteContext } from "@/server/domain/ticket/context";
import { selectableDepts } from "@/server/domain/ticket/assign";
import { checkStaffPerm, loadTicket } from "@/server/domain/ticket/ticket";
import { runWrite } from "@/server/domain/write";

/**
 * Server action dei task (scp/tasks.php, include/ajax.tasks.php). Sessione e permessi sono ricontrollati
 * qui come negli endpoint PHP (Task::checkStaffPerm con il permesso del ruolo nel reparto del task).
 */

function fromResult(r: TaskResult): PeopleActionState {
  return r.ok ? { ok: true, nonce: nonce() } : { error: r.error, nonce: nonce() };
}

/** Task accessibile all'agente con il permesso richiesto (null = sola visibilità). */
async function withTask(
  form: FormData,
  perm: string | null,
  fn: (ctx: WriteContext, task: TaskDbRow, row: TaskRow, agent: Agent) => Promise<PeopleActionState>,
): Promise<PeopleActionState> {
  const agent = await currentAgent();
  if (!agent) return { error: "session_expired" };
  const id = formNum(form, "taskId");
  const row = id ? await loadTask(id) : null;
  if (!row || !checkTaskPerm(row, agent)) return { error: "not_found", nonce: nonce() };
  if (perm && !checkTaskPerm(row, agent, perm)) return { error: "forbidden", nonce: nonce() };
  const r = await runWrite({ agent, ip: await clientIp() }, async (ctx) => {
    const task = await loadTaskRow(ctx.tx, id, true);
    if (!task) return { error: "not_found", nonce: nonce() };
    return fn(ctx, task, row, agent);
  });
  if (r.ok) {
    revalidatePath(`/agent/tasks/${id}`);
    revalidatePath("/agent/tasks");
  }
  return r;
}

/** scp/tasks.php a=postnote (stato facoltativo: chiusura/riapertura con i permessi relativi) */
export async function taskNoteAction(_prev: PeopleActionState, form: FormData): Promise<PeopleActionState> {
  return withTask(form, null, async (ctx, task, row, agent) => {
    const status = statusOf(form);
    if (status && !canChangeStatus(row, agent, status)) return { error: "forbidden", nonce: nonce() };
    const r = await postTaskNote(ctx, task, { note: formHtml(form, "note"), title: formStr(form, "title").trim(), status: status ?? undefined });
    if (r.ok) await deleteDraftsFor(ctx.tx, `task.note.${task.id}`, agent.id);
    return fromResult(r);
  });
}

/**
 * scp/tasks.php a=postreply. Il PHP non controlla task.reply nell'endpoint (mostra però il modulo
 * solo con quel permesso): qui il permesso è richiesto (regola più stretta).
 */
export async function taskReplyAction(_prev: PeopleActionState, form: FormData): Promise<PeopleActionState> {
  return withTask(form, TaskPerm.REPLY, async (ctx, task, row, agent) => {
    const status = statusOf(form);
    if (status && !canChangeStatus(row, agent, status)) return { error: "forbidden", nonce: nonce() };
    const r = await postTaskReply(ctx, task, { response: formHtml(form, "response"), status: status ?? undefined });
    if (r.ok) await deleteDraftsFor(ctx.tx, `task.response.${task.id}`, agent.id);
    return fromResult(r);
  });
}

function statusOf(form: FormData): "open" | "closed" | null {
  const s = formStr(form, "status");
  return s === "open" || s === "closed" ? s : null;
}

/** ajax.tasks.php:changeStatus: riapertura con task.create, chiusura con task.close */
function canChangeStatus(row: TaskRow, agent: Agent, status: "open" | "closed"): boolean {
  return checkTaskPerm(row, agent, status === "closed" ? TaskPerm.CLOSE : TaskPerm.CREATE);
}

export async function taskStatusAction(_prev: PeopleActionState, form: FormData): Promise<PeopleActionState> {
  const status = statusOf(form);
  if (!status) return { error: "invalid", nonce: nonce() };
  return withTask(form, status === "closed" ? TaskPerm.CLOSE : TaskPerm.CREATE, async (ctx, task) => fromResult(await setTaskStatus(ctx, task, status, formHtml(form, "comments"))));
}

/** ajax.tasks.php:assign (solo task aperti: AssignmentForm del PHP) */
export async function taskAssignAction(_prev: PeopleActionState, form: FormData): Promise<PeopleActionState> {
  return withTask(form, TaskPerm.ASSIGN, async (ctx, task) => {
    if ((task.flags & TaskFlag.ISOPEN) === 0) return { error: "closed", nonce: nonce() };
    const raw = formStr(form, "assignee");
    const m = /^([st])(\d+)$/.exec(raw);
    if (!m) return { error: "unknown_assignee", nonce: nonce() };
    return fromResult(await assignTask(ctx, task, { type: m[1] === "s" ? "staff" : "team", id: Number(m[2]) }, formHtml(form, "comments")));
  });
}

/** ajax.tasks.php:claim */
export async function taskClaimAction(_prev: PeopleActionState, form: FormData): Promise<PeopleActionState> {
  return withTask(form, TaskPerm.ASSIGN, async (ctx, task) => {
    if ((task.flags & TaskFlag.ISOPEN) === 0) return { error: "closed", nonce: nonce() };
    return fromResult(await claimTask(ctx, task, formHtml(form, "comments")));
  });
}

/** ajax.tasks.php:transfer (reparti selezionabili come DepartmentField) */
export async function taskTransferAction(_prev: PeopleActionState, form: FormData): Promise<PeopleActionState> {
  return withTask(form, TaskPerm.TRANSFER, async (ctx, task, _row, agent) => {
    const deptId = formNum(form, "dept");
    if (!(await selectableDepts(ctx.tx, agent, task.dept_id)).some((d) => d.id === deptId)) return { error: "dept_required", nonce: nonce() };
    return fromResult(await transferTask(ctx, task, deptId, formHtml(form, "comments")));
  });
}

/** ajax.tasks.php:edit (Task::update): titolo e altri campi del form, nota facoltativa */
export async function taskEditAction(_prev: PeopleActionState, form: FormData): Promise<PeopleActionState> {
  return withTask(form, TaskPerm.EDIT, async (ctx, task) => {
    const fields: Record<string, unknown> = {};
    for (const [k, v] of form.entries()) if (k.startsWith("f:")) fields[k.slice(2)] = String(v);
    return fromResult(await updateTaskFields(ctx, task, fields, formHtml(form, "note")));
  });
}

/** ajax.tasks.php:editField duedate: `due` è un istante ISO (vuoto = rimozione) */
export async function taskDueDateAction(_prev: PeopleActionState, form: FormData): Promise<PeopleActionState> {
  return withTask(form, TaskPerm.EDIT, async (ctx, task) =>
    fromResult(await updateTaskDueDate(ctx, task, formStr(form, "due") || null, formHtml(form, "comments"))),
  );
}

/** ajax.tasks.php:delete */
export async function taskDeleteAction(_prev: PeopleActionState, form: FormData): Promise<PeopleActionState> {
  const r = await withTask(form, TaskPerm.DELETE, async (ctx, task) => fromResult(await deleteTask(ctx, task, formHtml(form, "comments"))));
  // La pagina del task non esiste più: redirect lato server (il refresh della vista darebbe 404)
  if (r.ok) redirect({ href: "/agent/tasks", locale: await getLocale() });
  return r;
}

/**
 * ajax.tasks.php:add e ajax.tickets.php:addTask: con ticket serve task.create sul ticket
 * (Ticket::checkStaffPerm), altrimenti task.create in almeno un ruolo.
 */
export async function taskCreateAction(_prev: PeopleActionState, form: FormData): Promise<PeopleActionState> {
  const agent = await currentAgent();
  if (!agent) return { error: "session_expired" };
  const ticketId = formNum(form, "ticketId") || undefined;
  if (ticketId) {
    const t = await loadTicket(ticketId, agent.id);
    if (!t || !(await checkStaffPerm(t, agent, TaskPerm.CREATE))) return { error: "forbidden", nonce: nonce() };
  } else if (!agent.hasPermInAnyRole(TaskPerm.CREATE)) return { error: "forbidden", nonce: nonce() };
  const deptId = formNum(form, "dept");
  if (!deptId || !(await selectableDepts(db(), agent, null)).some((d) => d.id === deptId)) return { error: "dept_required", fields: { dept: "required" }, nonce: nonce() };
  const raw = formStr(form, "assignee");
  const m = /^([st])(\d+)$/.exec(raw);
  const r = await runWrite({ agent, ip: await clientIp() }, async (ctx) => {
    const res = await createTask(ctx, {
      ticketId,
      title: formStr(form, "title"),
      description: formHtml(form, "description"),
      deptId,
      assignee: m ? { type: m[1] === "s" ? "staff" : "team", id: Number(m[2]) } : null,
      duedate: formStr(form, "due") || null,
    });
    if (res.ok) await deleteDraftsFor(ctx.tx, "task.add", agent.id);
    return res;
  });
  if (!r.ok) return { error: r.error, fields: r.error === "title_required" ? { title: "required" } : undefined, nonce: nonce() };
  revalidatePath("/agent/tasks");
  return { ok: true, redirect: `/agent/tasks/${r.id}`, nonce: nonce() };
}

/** ajax.tasks.php:massProcess */
export async function taskMassAction(_prev: PeopleActionState, form: FormData): Promise<PeopleActionState> {
  const agent = await currentAgent();
  if (!agent) return { error: "session_expired" };
  const ids = formIds(form, "tids");
  if (!ids.length) return { error: "none_selected", nonce: nonce() };
  const action = formStr(form, "do");
  let op: TaskMassAction;
  switch (action) {
    case "claim":
      op = { action: "claim" };
      break;
    case "close":
    case "reopen":
    case "delete":
      op = { action, comments: formHtml(form, "comments") };
      break;
    case "transfer":
      op = { action: "transfer", deptId: formNum(form, "dept") };
      break;
    case "assign": {
      const m = /^([st])(\d+)$/.exec(formStr(form, "assignee"));
      if (!m) return { error: "unknown_assignee", nonce: nonce() };
      op = { action: "assign", to: { type: m[1] === "s" ? "staff" : "team", id: Number(m[2]) } };
      break;
    }
    default:
      return { error: "invalid", nonce: nonce() };
  }
  // Task::checkStaffPerm stretto (anche i task chiusi richiedono accesso al reparto)
  const visible: number[] = [];
  for (const id of ids) {
    const row = await loadTask(id);
    if (row && checkTaskPerm(row, agent)) visible.push(id);
  }
  const count = await runWrite({ agent, ip: await clientIp() }, (ctx) => massTaskAction(ctx, visible, op));
  revalidatePath("/agent/tasks");
  if (!count) return { error: "none_processed", nonce: nonce() };
  return { ok: true, count, notice: count === ids.length ? "mass_done" : "mass_partial", nonce: nonce() };
}
