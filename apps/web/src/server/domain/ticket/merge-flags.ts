import "server-only";

import { Ticket } from "@/lib/osticket/flags";

import type { DbOrTx } from "../../db";
import { TicketRecord } from "./record";

/**
 * Flag di merge/link del ticket (Ticket::FLAG_*) e helper comuni a merge, link ed eliminazione
 * (area "ticketedit").
 */

type MergeType = "combine" | "separate" | "visual";

/** Ticket::getMergeTypeByFlag */
export function mergeTypeOf(flags: number): MergeType {
  if (flags & Ticket.COMBINE_THREADS) return "combine";
  if (flags & Ticket.SEPARATE_THREADS) return "separate";
  return "visual";
}

export function isParentFlags(flags: number): boolean {
  return (flags & Ticket.PARENT) !== 0;
}

/**
 * Ticket::setMergeType($combine, $parent) senza il save: 0 = separate, 1 = combine, 2 = link,
 * 3 = ticket normale (tutti i flag azzerati). Il confronto PHP 8 `$combine == $key` è debole: null
 * vale 0 (separate), una stringa vuota non corrisponde a nessuna chiave.
 */
function mergeFlags(flags: number, combine: number | string | null | undefined, parent: boolean): number {
  const keys = [Ticket.SEPARATE_THREADS, Ticket.COMBINE_THREADS, Ticket.LINKED];
  const c = combine === null || combine === undefined ? 0 : combine === "" ? NaN : Number(combine);
  keys.forEach((flag, key) => {
    if (c === key) flags |= flag;
    else flags &= ~flag;
  });
  if (parent) flags |= Ticket.PARENT;
  else flags &= ~Ticket.PARENT;
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

/** Ticket::getChildTickets($pid): figli ordinati per `sort` (ticket_id, number). */
export async function childTickets(executor: DbOrTx, pid: number): Promise<{ ticket_id: number; number: string | null }[]> {
  return executor.selectFrom("ticket").select(["ticket_id", "number"]).where("ticket_pid", "=", pid).orderBy("sort").orderBy("ticket_id").execute();
}
