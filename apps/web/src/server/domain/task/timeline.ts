import "server-only";

import { ThreadEntry } from "@/lib/osticket/flags";

import { coreConfig } from "../../config/config";
import type { Agent } from "../staff/staff";
import { loadThreadEntries, loadThreadEvents } from "../ticket/ticket";
import { sortTimeline, withEventRefs, type TimelineItem } from "../ticket/view";

/**
 * Thread del task come nella vista ticket (task-view.tmpl.php: Thread::render con gli eventi): voci non
 * nascoste ed eventi (creazione, assegnazione, trasferimento, chiusura…) in ordine cronologico, invertito
 * se l'agente preferisce l'ordine decrescente. Nomi e ordinamento sono quelli della vista ticket.
 */
export async function loadTaskTimeline(agent: Agent, threadId: number | null): Promise<TimelineItem[]> {
  if (!threadId) return [];
  const [entries, events, cfg] = await Promise.all([loadThreadEntries(threadId), loadThreadEvents(threadId), coreConfig()]);
  const items = sortTimeline([...entries.filter((e) => !(e.flags & ThreadEntry.HIDDEN)), ...(await withEventRefs(events))]);
  const order = agent.config.str("thread_view_order") || cfg.str("thread_view_order", "ASC");
  return order === "DESC" ? items.reverse() : items;
}
