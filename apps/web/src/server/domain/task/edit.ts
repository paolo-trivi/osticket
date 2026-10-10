import "server-only";

import { DateTime } from "luxon";

import { entriesFor, saveEntryAnswers, validateInput } from "../forms/answers";
import { currentTimezone } from "../forms/entry";
import { hasAnswerRow, isEditableToStaff, type FieldErrorCode } from "../forms/fields";
import { taskThreadId } from "../thread/ids";
import type { WriteContext } from "../ticket/context";
import { logTaskEvent, updateTaskRow, type TaskDbRow } from "./model";
import { invalidFields, isoToDb, type TaskResult } from "./common";
import { postTaskNote } from "./posts";

/** Modifica dei task: campi del form (Task::update) e scadenza (Task::updateField 'duedate'). */

/** Task::update($forms, $vars): campi del form, nota facoltativa, evento edited. */
export async function updateTaskFields(ctx: WriteContext, task: TaskDbRow, fields: Record<string, unknown>, note = ""): Promise<TaskResult> {
  const { tx } = ctx;
  const entries = await entriesFor(tx, "A", task.id);
  if (!entries.length) return { ok: false, error: "not_found" };
  const timezone = await currentTimezone(ctx);
  // Errori di tutti i form uniti (array_merge di $form->errors()), poi nessuna scrittura
  const errors: Record<string, FieldErrorCode> = {};
  for (const e of entries) Object.assign(errors, await validateInput(e.fields, fields, (f) => isEditableToStaff(f), ctx.cfg, { timezone }));
  if (Object.keys(errors).length) return invalidFields(errors);
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
