import "server-only";

import { DateTime } from "luxon";

import { TaskModel, Team, ThreadEntry } from "@/lib/osticket/flags";
import { FormType, ObjectType, ThreadEntryType } from "@/lib/osticket/object-types";

import { NOW } from "../../db";
import { defaultFormOf, validateInput } from "../forms/answers";
import { currentTimezone, FormInstance, saveFormEntry } from "../forms/entry";
import { nextSequenceNumber } from "../sequence";
import { loadAgent, TaskPerm } from "../staff/staff";
import { createThreadEntry } from "../thread/write";
import type { WriteContext } from "../ticket/context";
import { agentName, assignableAgents, loadTaskRow, loadTeam, logTaskEvent } from "./model";
import { invalidFields, bodyFormat, isoToDb, type TaskResult } from "./common";
import { onNewTask } from "./alerts";
import { assignTask, type TaskAssignee } from "./assign";

/** Creazione dei task (Task::create) con la numerazione ($cfg->getNewTaskNumber). */

/** $cfg->getNewTaskNumber(): sequenza task_sequence_id (RandomSequence se assente) con Task::isNumberUnique. */
async function nextTaskNumber(ctx: WriteContext): Promise<string> {
  const { tx, cfg } = ctx;
  return nextSequenceNumber(tx, cfg.int("task_sequence_id"), cfg.str("task_number_format"), async (n) => {
    const dup = await tx.selectFrom("task").select("id").where("number", "=", n).executeTakeFirst();
    return !dup;
  });
}

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

/** Task::create (ajax.tasks.php:add, ajax.tickets.php:addTask) */
export async function createTask(ctx: WriteContext, input: NewTaskInput): Promise<TaskResult<{ id: number; number: string }>> {
  const { tx, cfg, agent } = ctx;
  if (!agent || !agent.hasPermInAnyRole(TaskPerm.CREATE)) return { ok: false, error: "forbidden" };
  const form = await defaultFormOf(tx, "A");
  if (!form) return { ok: false, error: "not_found" };
  const values: Record<string, unknown> = { ...(input.fields ?? {}), title: input.title, description: input.description };
  const timezone = await currentTimezone(ctx);
  // TaskForm::getInstance()->setSource($_POST) + $form->isValid(): un errore in un campo qualsiasi
  // del form blocca la creazione
  const inst = new FormInstance({ id: form.id, type: FormType.TASK, title: "", instructions: "", fields: form.fields }, values, 1, null, { timezone });
  const errors = await validateInput(form.fields, values, () => true, cfg, { timezone });
  if (Object.keys(errors).length) return invalidFields(errors);
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

  // addDynamicData($form->getClean()): entry del form "Task Details" con i valori puliti già validati
  // (setAnswer; la nuova entry rilegge il POST, che dà gli stessi valori: la scelta multipla resta)
  await saveFormEntry(tx, inst, FormType.TASK, id);

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
