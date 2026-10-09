import "server-only";

import type { DbOrTx } from "../../db";
import { TicketRecord } from "./record";

/**
 * Flag di merge/link del ticket (Ticket::FLAG_*) e helper comuni a merge, link ed eliminazione
 * (area "ticketedit").
 */
export const TicketFlag = {
  COMBINE_THREADS: 0x0001,
  SEPARATE_THREADS: 0x0002,
  LINKED: 0x0008,
  PARENT: 0x0010,
} as const;

type MergeType = "combine" | "separate" | "visual";

/** Ticket::getMergeTypeByFlag */
export function mergeTypeOf(flags: number): MergeType {
  if (flags & TicketFlag.COMBINE_THREADS) return "combine";
  if (flags & TicketFlag.SEPARATE_THREADS) return "separate";
  return "visual";
}

export function isParentFlags(flags: number): boolean {
  return (flags & TicketFlag.PARENT) !== 0;
}

/**
 * Ticket::setMergeType($combine, $parent) senza il save: 0 = separate, 1 = combine, 2 = link,
 * 3 = ticket normale (tutti i flag azzerati). Il confronto PHP 8 `$combine == $key` è debole: null
 * vale 0 (separate), una stringa vuota non corrisponde a nessuna chiave.
 */
function mergeFlags(flags: number, combine: number | string | null | undefined, parent: boolean): number {
  const keys = [TicketFlag.SEPARATE_THREADS, TicketFlag.COMBINE_THREADS, TicketFlag.LINKED];
  const c = combine === null || combine === undefined ? 0 : combine === "" ? NaN : Number(combine);
  keys.forEach((flag, key) => {
    if (c === key) flags |= flag;
    else flags &= ~flag;
  });
  if (parent) flags |= TicketFlag.PARENT;
  else flags &= ~TicketFlag.PARENT;
  return flags;
}

/** Ticket::setMergeType: imposta i flag e salva (Ticket::save → updated + `_search` se cambia qualcosa). */
export async function setMergeType(rec: TicketRecord, combine: number | string | null | undefined, parent = false): Promise<void> {
  rec.set("flags", mergeFlags(rec.get("flags"), combine, parent));
  await rec.save();
}

/** Ticket::setPid: null se uguale all'id del ticket stesso. */
export function setPid(rec: TicketRecord, pid: number | null): void {
  rec.set("ticket_pid", rec.id !== pid ? pid : null);
}

/**
 * Ticket::getThread(): thread di tipo 'T' del ticket, altrimenti il thread "child" di tipo 'C'
 * (ticket figlio di un merge con thread combinati).
 */
export async function ticketThread(executor: DbOrTx, ticketId: number): Promise<{ id: number; object_type: string; extra: string | null } | null> {
  const rows = await executor
    .selectFrom("thread")
    .select(["id", "object_type", "extra"])
    .where("object_id", "=", ticketId)
    .where("object_type", "in", ["T", "C"])
    .execute();
  return rows.find((r) => r.object_type === "T") ?? rows.find((r) => r.object_type === "C") ?? null;
}

/** Ticket::getChildTickets($pid): figli ordinati per `sort` (ticket_id, number). */
export async function childTickets(executor: DbOrTx, pid: number): Promise<{ ticket_id: number; number: string | null }[]> {
  return executor.selectFrom("ticket").select(["ticket_id", "number"]).where("ticket_pid", "=", pid).orderBy("sort").orderBy("ticket_id").execute();
}
