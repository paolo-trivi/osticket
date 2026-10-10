import "server-only";

import { TaskPerm } from "../staff/staff";
import { selectableDepts } from "../ticket/assignees";
import type { WriteContext } from "../ticket/context";
import { loadTaskRow } from "./model";
import { checkTaskPerm, loadTask } from "./tasks";
import type { TaskResult } from "./common";
import { setTaskStatus } from "./posts";
import { assignTask, claimTask, transferTask, type TaskAssignee } from "./assign";
import { deleteTask } from "./delete";

/** Azioni di massa sui task (ajax.tasks.php:massProcess). */

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
  // TransferForm (DepartmentField) del PHP: solo reparti attivi selezionabili dall'agente
  if (op.action === "transfer" && !(await selectableDepts(ctx.tx, agent, null)).some((d) => d.id === op.deptId)) return 0;
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
