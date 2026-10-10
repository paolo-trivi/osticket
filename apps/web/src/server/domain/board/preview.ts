import "server-only";

import { sql } from "kysely";

import { ThreadEntry } from "@/lib/osticket/flags";
import { ThreadEntryType } from "@/lib/osticket/object-types";

import { db, type DbOrTx } from "../../db";
import { agentTimeZone, formatDbDate } from "../../format/datetime";
import { decodeHtml401Entities, htmlDecode, phpStripTags } from "../../format/html";
import type { Agent } from "../staff/staff";
import { checkStaffPerm, loadTicket } from "../ticket/ticket";
import type { BoardPreview } from "./types";

/**
 * Anteprima di un ticket per il pannello laterale della board: ultime voci visibili del thread in testo
 * semplice. Sola lettura: niente lock né eventi (come aprire la lista, non la vista del ticket).
 */

export type { BoardPreview,  } from "./types";

const EXCERPT = 320;

/** Testo semplice da un corpo HTML/testo del thread (per l'estratto). */
export function plainExcerpt(body: string, format: string, max = EXCERPT): string {
  let s = body ?? "";
  if (format === "html") {
    s = s
      .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h\d|blockquote)>/gi, "\n");
    // entità HTML 4.01 e numeriche, poi &amp; &lt; &gt; &quot; (testo semplice)
    s = htmlDecode(decodeHtml401Entities(phpStripTags(s)));
  }
  s = s
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

export async function ticketPreview(
  agent: Agent,
  ticketId: number,
  locale: string,
  executor: DbOrTx = db(),
): Promise<BoardPreview | null> {
  // Stesso controllo di accesso della vista del ticket (Ticket::checkStaffPerm senza permesso specifico)
  const t = await loadTicket(ticketId, agent.id, executor);
  if (!t || !(await checkStaffPerm(t, agent, undefined, executor))) return null;
  const [tz, rows] = await Promise.all([
    agentTimeZone(agent),
    t.thread_id
      ? executor
          .selectFrom("thread_entry")
          .select(["id", "type", "poster", "created", "body", "format"])
          .where("thread_id", "=", t.thread_id)
          .where(sql<boolean>`(flags & ${sql.lit(ThreadEntry.HIDDEN)}) = 0`)
          .orderBy("created", "desc")
          .orderBy("id", "desc")
          .limit(3)
          .execute()
      : Promise.resolve([]),
  ]);
  return {
    id: t.ticket_id,
    number: t.number ?? "",
    entries: rows.map((r) => ({
      id: Number(r.id),
      type: r.type === ThreadEntryType.RESPONSE ? ThreadEntryType.RESPONSE : r.type === ThreadEntryType.NOTE ? ThreadEntryType.NOTE : ThreadEntryType.MESSAGE,
      poster: r.poster ?? "",
      when: formatDbDate(r.created, tz, locale, "human"),
      whenTitle: formatDbDate(r.created, tz, locale),
      excerpt: plainExcerpt(r.body ?? "", r.format ?? "text"),
    })),
  };
}
