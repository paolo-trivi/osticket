import "server-only";

import { sql } from "kysely";

import { DynamicFormField, TaskModel } from "@/lib/osticket/flags";
import { ObjectType, ThreadEntryType } from "@/lib/osticket/object-types";

import { table, type DbOrTx } from "../../db";
import type { Agent } from "../staff/staff";
import { taskThreadId, ticketThreadId } from "../thread/ids";
import { createThreadEntry, lastMessage, touchThread } from "../thread/write";
import type { WriteContext } from "../ticket/context";
import { logNote } from "../ticket/post";
import { TicketRecord } from "../ticket/record";
import { reopenTicket } from "../ticket/ticket-state";
import { agentName, logTaskEvent, updateTaskRow, type TaskDbRow } from "./model";
import { isOpen, bodyFormat, type TaskResult } from "./common";
import { onActivity } from "./alerts";

/**
 * Note, risposte e cambi di stato del task (Task::postNote, Task::postReply, Task::setStatus): si
 * richiamano a vicenda (nota con cambio di stato, commento del cambio di stato come nota).
 */

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
