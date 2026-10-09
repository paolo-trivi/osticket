import "server-only";

import { NOW, type DbOrTx } from "../../db";
import { phpJsonEncode } from "../../format/php-json";
import type { TicketColumns } from "./record";

/**
 * Chi esegue un'operazione: equivale ai globali $thisstaff / $thisclient del PHP.
 * `null` = sistema (cron, filtri).
 */
export type Actor =
  | { kind: "staff"; id: number; username: string; name: string; ip: string }
  | { kind: "user"; id: number; name: string; email: string; hasAccount: boolean; ip: string }
  | null;

export type EventState =
  | "created" | "closed" | "reopened" | "assigned" | "released" | "transferred" | "referred" | "overdue"
  | "edited" | "viewed" | "error" | "collab" | "resent" | "deleted" | "merged" | "unlinked" | "linked"
  | "login" | "logout" | "message" | "note";

let eventIdCache: Map<string, number> | null = null;

async function eventId(executor: DbOrTx, name: string): Promise<number> {
  if (!eventIdCache) {
    const rows = await executor.selectFrom("event").select(["id", "name"]).execute();
    eventIdCache = new Map(rows.map((r) => [r.name, r.id]));
  }
  return eventIdCache.get(name) ?? 0;
}

/**
 * ThreadEvents::log + ThreadEvent::forTicket/forTask (include/class.thread.php:2343).
 * `who` è il parametro $user del PHP: stringa (username forzato), attore esplicito, o undefined
 * (si usa l'attore corrente come $thisclient ?: $thisstaff).
 */
export async function logThreadEvent(
  executor: DbOrTx,
  opts: {
    threadId: number;
    threadType: "T" | "A";
    state: EventState;
    data?: Record<string, unknown> | string | null;
    actor: Actor;
    who?: string | Actor;
    annul?: EventState;
    /** stato dell'oggetto al momento del log */
    staffId: number;
    teamId: number;
    deptId: number;
    topicId?: number;
  },
): Promise<void> {
  const id = await eventId(executor, opts.state);
  if (opts.annul) {
    const annulId = await eventId(executor, opts.annul);
    await executor
      .updateTable("thread_event")
      .set({ annulled: 1 })
      .where("thread_id", "=", opts.threadId)
      .where("event_id", "=", annulId)
      .execute();
  }

  // ThreadEvent::create: uid dall'utente passato, altrimenti $thisstaff ?: $thisclient
  const uidActor = (typeof opts.who === "object" && opts.who) || opts.actor;
  // ThreadEvents::log: username
  let username: string;
  if (typeof opts.who === "string") username = opts.who;
  else {
    const user = (typeof opts.who === "object" && opts.who) || opts.actor;
    if (user?.kind === "staff") username = user.username;
    else if (opts.actor?.kind === "user") username = (opts.actor.hasAccount ? opts.actor.name : "") || opts.actor.email;
    else username = "SYSTEM";
  }

  let data: string | null = null;
  if (opts.data) data = typeof opts.data === "string" ? opts.data : phpJsonEncode(opts.data);

  await executor
    .insertInto("thread_event")
    .values({
      thread_id: opts.threadId,
      thread_type: opts.threadType,
      event_id: id,
      staff_id: opts.staffId || 0,
      team_id: opts.teamId || 0,
      dept_id: opts.deptId,
      topic_id: opts.topicId ?? 0,
      data,
      username,
      uid: uidActor ? uidActor.id : null,
      uid_type: uidActor?.kind === "user" ? "U" : "S",
      timestamp: NOW,
    })
    .execute();
}

/** Ticket::logEvent: staff_id = agente corrente se il ticket non è assegnato (ThreadEvent::forTicket). */
export async function logTicketEvent(
  executor: DbOrTx,
  ticket: TicketColumns,
  threadId: number,
  actor: Actor,
  state: EventState,
  data?: Record<string, unknown> | null,
  who?: string | Actor,
  annul?: EventState,
): Promise<void> {
  const staffId = actor?.kind === "staff" && !ticket.staff_id ? actor.id : ticket.staff_id;
  await logThreadEvent(executor, {
    threadId,
    threadType: "T",
    state,
    data,
    actor,
    who,
    annul,
    staffId,
    teamId: ticket.team_id,
    deptId: ticket.dept_id,
    topicId: ticket.topic_id,
  });
}
