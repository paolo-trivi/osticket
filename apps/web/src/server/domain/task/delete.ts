import "server-only";

import { sql } from "kysely";

import { table } from "../../db";
import { logSystem } from "../../system/syslog";
import { deleteEntries } from "../forms/answers";
import { deleteDraftsForNamespace } from "../drafts";
import { deleteSearchRow } from "../search/index-writer";
import { taskThreadId } from "../thread/ids";
import type { WriteContext } from "../ticket/context";
import { agentName, logTaskEvent, type TaskDbRow } from "./model";
import type { TaskResult } from "./common";

/** Eliminazione dei task (Task::delete). */

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
