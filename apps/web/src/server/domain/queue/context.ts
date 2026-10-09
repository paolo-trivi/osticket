import "server-only";

import { cache } from "react";

import { coreConfig } from "../../config/config";
import { agentTimeZone } from "../../format/datetime";
import type { Agent } from "../staff/staff";
import { loadQueues, navigableQueues, queueCounts, type TicketQueue } from "./engine";

/** Code navigabili dell'agente con i contatori (una query per richiesta). */
export const agentQueueNav = cache(async (agent: Agent) => {
  const all = await loadQueues();
  const queues = navigableQueues(all, agent);
  const counts = await queueCounts(agent, queues, { userTz: await agentTimeZone(agent) });
  const top = queues.filter((q) => !q.row.parent_id || !queues.some((p) => p.id === q.row.parent_id));
  return { all, queues, top, counts };
});

/** Coda predefinita: preferenza agente (default_ticket_queue_id), poi core.default_ticket_queue, poi 1. */
export async function defaultQueueId(agent: Agent): Promise<number> {
  const own = agent.config.int("default_ticket_queue_id");
  if (own) return own;
  return (await coreConfig()).int("default_ticket_queue", 1) || 1;
}

/** Righe per pagina: preferenza agente (max_page_size), poi core.max_page_size, poi 25. */
export async function pageSizeFor(agent: Agent): Promise<number> {
  return agent.row.max_page_size || (await coreConfig()).int("max_page_size", 25) || 25;
}

export function queueTitleKey(q: TicketQueue): string {
  return q.title;
}
