import "server-only";

import { db, type DbOrTx } from "../../db";
import { agentQueueNav } from "../queue/context";
import type { TicketQueue } from "../queue/engine";
import type { Agent } from "../staff/staff";
import { safeColor } from "./grouping";
import type { BoardSourceOption } from "./types";

/** Scelte della barra della board: sorgenti (code e ricerche) e priorità dei filtri rapidi. */

/**
 * Sorgenti selezionabili: le code navigabili dell'agente (agentQueueNav, come la barra laterale) ad albero,
 * poi le ricerche personali. Titoli grezzi: la pagina li traduce come la lista ticket.
 */
export async function boardSources(agent: Agent): Promise<BoardSourceOption[]> {
  const { queues, top, counts } = await agentQueueNav(agent);
  const navigable = new Set(queues.map((q) => q.id));
  const out: BoardSourceOption[] = [];
  const walk = (nodes: TicketQueue[], depth: number) => {
    for (const q of nodes) {
      const c = counts.get(q.id);
      out.push({ value: String(q.id), title: q.title, depth, count: c === undefined ? null : c });
      walk(
        q.children.filter((ch) => navigable.has(ch.id)),
        depth + 1,
      );
    }
  };
  walk(
    top.filter((q) => q.isAQueue),
    0,
  );
  walk(
    top.filter((q) => !q.isAQueue),
    0,
  );
  return out;
}

/** Priorità per i filtri rapidi (ordinate per urgenza). */
export async function boardPriorities(executor: DbOrTx = db()): Promise<Array<{ id: number; name: string; color: string | null }>> {
  const rows = await executor
    .selectFrom("ticket_priority")
    .select(["priority_id", "priority_desc", "priority_color"])
    .orderBy("priority_urgency")
    .execute();
  return rows.map((r) => ({ id: r.priority_id, name: r.priority_desc, color: safeColor(r.priority_color) }));
}
