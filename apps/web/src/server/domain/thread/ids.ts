import "server-only";

import { ObjectType } from "@/lib/osticket/object-types";

import type { DbOrTx } from "../../db";

/**
 * Thread di un oggetto (tabella thread, chiave object_type + object_id): helper comuni a ticket e task.
 */

/**
 * Ticket::getThread(): thread di tipo 'T' del ticket, altrimenti il thread "child" di tipo 'C'
 * (ticket figlio di un merge con thread combinati).
 */
export async function ticketThread(executor: DbOrTx, ticketId: number): Promise<{ id: number; object_type: string; extra: string | null } | null> {
  const rows = await executor
    .selectFrom("thread")
    .select(["id", "object_type", "extra"])
    .where("object_id", "=", ticketId)
    .where("object_type", "in", [ObjectType.TICKET, ObjectType.CHILD_TICKET])
    .execute();
  return rows.find((r) => r.object_type === ObjectType.TICKET) ?? rows.find((r) => r.object_type === ObjectType.CHILD_TICKET) ?? null;
}

/** Id del thread di Ticket::getThread() ('T' o 'C'), 0 se manca. */
export async function currentTicketThreadId(executor: DbOrTx, ticketId: number): Promise<number> {
  return (await ticketThread(executor, ticketId))?.id ?? 0;
}

/** Thread del ticket (solo tipo 'T'), null se manca. */
export async function findTicketThreadId(executor: DbOrTx, ticketId: number): Promise<number | null> {
  const th = await executor.selectFrom("thread").select("id").where("object_type", "=", ObjectType.TICKET).where("object_id", "=", ticketId).executeTakeFirst();
  return th?.id ?? null;
}

/** Thread del ticket (solo tipo 'T'): errore se manca */
export async function ticketThreadId(executor: DbOrTx, ticketId: number): Promise<number> {
  const id = await findTicketThreadId(executor, ticketId);
  if (id === null) throw new Error(`Thread del ticket ${ticketId} mancante`);
  return id;
}

/** Thread del task, 0 se manca. */
export async function taskThreadId(executor: DbOrTx, taskId: number): Promise<number> {
  const th = await executor.selectFrom("thread").select("id").where("object_type", "=", ObjectType.TASK).where("object_id", "=", taskId).executeTakeFirst();
  return th?.id ?? 0;
}
