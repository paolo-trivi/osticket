/**
 * Scritture sui task (include/class.task.php, include/ajax.tasks.php, scp/tasks.php) con le stesse righe
 * del PHP: task, task__cdata, form_entry(_values), thread 'A', thread_entry, thread_event, sequence,
 * _search, avvisi email (task.alert, task.activity.alert, task.assignment.alert, task.transfer.alert).
 * Facciata dei moduli: ./common (esiti), ./alerts (avvisi), ./posts (note, risposte, stato),
 * ./assign (assegnazione, claim, trasferimento), ./create, ./edit (campi e scadenza), ./delete, ./mass.
 */
export type { TaskResult } from "./common";
export { missingRequiredFields, postTaskNote, postTaskReply, setTaskStatus } from "./posts";
export { assignTask, claimTask, transferTask } from "./assign";
export { createTask } from "./create";
export { updateTaskDueDate, updateTaskFields } from "./edit";
export { deleteTask } from "./delete";
export { massTaskAction, type TaskMassAction } from "./mass";
