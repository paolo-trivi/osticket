import "server-only";

import { randomInt } from "node:crypto";

import type { ConfigNamespace } from "../../config/config";
import { NOW, type DbOrTx } from "../../db";

/**
 * Numerazione dei ticket (include/class.sequence.php, Topic::getNewTicketNumber,
 * OsticketConfig::getNewTicketNumber): sequenza del DB con SELECT … FOR UPDATE oppure RandomSequence,
 * formato con i "#" e ripetizione finché il numero non è libero (Ticket::isTicketNumberUnique).
 */

/** Sequence::getDigitCount: numero di "#" non preceduti da "\" */
export function digitCount(format: string): number {
  return (format.match(/(?<!\\)#/g) ?? []).length;
}

/** Sequence::format($format, $number) */
export function formatSequence(format: string, number: number | string, padding = "0"): string {
  const groups = [...format.matchAll(/(?<!\\)#+/g)];
  const total = groups.reduce((n, g) => n + g[0].length, 0);
  let num = String(number);
  if (num.length < total) num = (padding || " ").repeat(total).slice(0, total - num.length) + num;
  let output = "";
  let start = 0;
  let noff = 0;
  for (const g of groups) {
    const size = g[0].length;
    output += format.slice(start, g.index).replaceAll("\\#", "#");
    output += num.slice(noff, noff + size);
    start = g.index! + size;
    noff += size;
  }
  if (num.length > noff) output += num.slice(noff);
  output += format.slice(start).replaceAll("\\#", "#");
  return output;
}

/** Misc::randNumber($len): prima cifra 1-9, le altre 0-9 */
export function randNumber(len: number): number {
  let s = "";
  for (let i = 0; i < len; i++) s += String(randomInt(i === 0 ? 1 : 0, 10));
  return Number(s);
}

async function isNumberUnique(executor: DbOrTx, number: string): Promise<boolean> {
  const r = await executor.selectFrom("ticket").select("ticket_id").where("number", "=", number).executeTakeFirst();
  return !r;
}

/**
 * Sequence::next($format, $check): con una sequenza del DB la riga viene bloccata (FOR UPDATE),
 * `next` incrementato di `increment` e `updated = NOW()`; con RandomSequence (sequenza 0 o mancante)
 * numeri casuali di almeno 6 cifre.
 */
export async function nextSequenceNumber(executor: DbOrTx, sequenceId: number, format: string): Promise<string> {
  const digits = digitCount(format);
  const seq = sequenceId
    ? await executor.selectFrom("sequence").select(["id", "next", "increment", "padding"]).where("id", "=", sequenceId).executeTakeFirst()
    : undefined;
  for (;;) {
    let next: number;
    let padding = "0";
    if (seq) {
      const locked = await executor
        .selectFrom("sequence")
        .select(["id", "next", "increment", "padding"])
        .where("id", "=", seq.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      next = Number(locked.next);
      padding = locked.padding ?? "0";
      await executor
        .updateTable("sequence")
        .set({ next: next + Number(locked.increment), updated: NOW })
        .where("id", "=", seq.id)
        .execute();
    } else {
      next = randNumber(Math.max(digits, 6));
    }
    const formatted = format ? formatSequence(format, next, padding) : String(next);
    if (await isNumberUnique(executor, formatted)) return formatted;
  }
}

/** Topic::getNewTicketNumber / OsticketConfig::getNewTicketNumber */
export async function newTicketNumber(
  executor: DbOrTx,
  cfg: ConfigNamespace,
  topic: { flags: number; sequence_id: number; number_format: string | null } | null,
): Promise<string> {
  // Topic::FLAG_CUSTOM_NUMBERS = 0x0001
  if (topic && topic.flags & 0x0001) return nextSequenceNumber(executor, topic.sequence_id, topic.number_format || "######");
  return nextSequenceNumber(executor, cfg.int("ticket_sequence_id"), cfg.str("ticket_number_format"));
}
