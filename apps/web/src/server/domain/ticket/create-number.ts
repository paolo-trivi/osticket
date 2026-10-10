import "server-only";

import { Topic } from "@/lib/osticket/flags";

import type { ConfigNamespace } from "../../config/config";
import type { DbOrTx } from "../../db";
import { nextSequenceNumber } from "../sequence";

/**
 * Numerazione dei ticket (Topic::getNewTicketNumber, OsticketConfig::getNewTicketNumber): sequenza del
 * help topic con numerazione propria o sequenza di sistema, con il controllo Ticket::isTicketNumberUnique.
 * Sequenza e formato sono in ../sequence.ts, condivisi con i task.
 */

/** Ticket::isTicketNumberUnique */
async function isNumberUnique(executor: DbOrTx, number: string): Promise<boolean> {
  const r = await executor.selectFrom("ticket").select("ticket_id").where("number", "=", number).executeTakeFirst();
  return !r;
}

/** Topic::getNewTicketNumber / OsticketConfig::getNewTicketNumber */
export async function newTicketNumber(
  executor: DbOrTx,
  cfg: ConfigNamespace,
  topic: { flags: number; sequence_id: number; number_format: string | null } | null,
): Promise<string> {
  const check = (n: string) => isNumberUnique(executor, n);
  if (topic && topic.flags & Topic.CUSTOM_NUMBERS) return nextSequenceNumber(executor, topic.sequence_id, topic.number_format || "######", check);
  return nextSequenceNumber(executor, cfg.int("ticket_sequence_id"), cfg.str("ticket_number_format"), check);
}
