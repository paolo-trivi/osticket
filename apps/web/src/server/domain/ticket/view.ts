import "server-only";

import { TicketStatus, ThreadEntry } from "@/lib/osticket/flags";
import { ObjectType } from "@/lib/osticket/object-types";

import { coreConfig } from "../../config/config";
import { db } from "../../db";
import { agentTimeZone } from "../../format/datetime";
import { listCanned } from "../kb/kb";
import { TicketPerm, type Agent, type RoleInfo } from "../staff/staff";
import { listTasks, type TaskRow } from "../task/tasks";
import { formatAgentName } from "./rows";
import {
  checkStaffPerm,
  loadCollaborators,
  loadThreadEntries,
  loadThreadEvents,
  loadTicket,
  loadTicketAnswers,
  roleOn,
  type ThreadEntryView,
  type ThreadEventView,
  type TicketDetail,
} from "./ticket";

/**
 * Dati della vista ticket dell'agente (scp/tickets.php?id=, include/staff/ticket-view.inc.php): un solo
 * caricamento per la pagina, che poi si limita a comporre le sezioni di components/tickets/view.
 */

/** Nomi degli oggetti citati da un evento del thread (assegnatario, team, reparto, stato); "" se assente. */
export interface ThreadEventRefs {
  staff: string;
  team: string;
  dept: string;
  status: string;
}

export type TimelineEvent = ThreadEventView & { refs: ThreadEventRefs };
export type TimelineItem = ThreadEntryView | TimelineEvent;

export type TicketCollaborator = Awaited<ReturnType<typeof loadCollaborators>>[number];
export type TicketAnswer = Awaited<ReturnType<typeof loadTicketAnswers>>[number];

/** Proprietà del composer (risposta / nota interna) calcolate dal server. */
export interface TicketComposerData {
  ticketId: number;
  canReply: boolean;
  lockMode: number;
  statuses: { id: number; name: string; state: string }[];
  currentStatusId: number;
  collaborators: { userId: number; name: string; email: string; active: boolean }[];
  canned: { id: number; title: string }[];
  hasMySignature: boolean;
  deptSignature: boolean;
  defaultSignature: string;
  uploadUrl?: string;
  maxFileSize: number;
}

interface TicketViewModel {
  ticket: TicketDetail;
  role: RoleInfo;
  tz: string;
  /** domini ammessi per gli iframe incorporati nei messaggi */
  iframeWhitelist: string[];
  /** voci ed eventi del thread nell'ordine scelto dall'agente */
  timeline: TimelineItem[];
  /** nome dell'agente assegnatario ("" se non assegnato) */
  assignee: string;
  /** URL dell'osTicket PHP per il rimando al pannello classico */
  legacyUrl?: string;
  taskCount: number;
  tasks: TaskRow[];
  collaborators: TicketCollaborator[];
  answers: TicketAnswer[];
  composer: TicketComposerData;
}

/** Ticket con tutto ciò che serve alla vista; null se inesistente o non accessibile (stesso messaggio del PHP). */
export async function loadTicketView(agent: Agent, ticketId: number): Promise<TicketViewModel | null> {
  const ticket = await loadTicket(ticketId, agent.id);
  if (!ticket || !(await checkStaffPerm(ticket, agent))) return null;

  const tz = await agentTimeZone(agent);
  const cfg = await coreConfig();
  const iframeWhitelist = cfg.str("embedded_domain_whitelist").split(/[,\s]+/).filter(Boolean);

  const [entries, events, answers, collaborators] = await Promise.all([
    // Thread::getEntries() esclude le voci nascoste (versioni precedenti di una voce modificata)
    ticket.thread_id ? loadThreadEntries(ticket.thread_id).then((l) => l.filter((e) => !(e.flags & ThreadEntry.HIDDEN))) : Promise.resolve([] as ThreadEntryView[]),
    ticket.thread_id ? loadThreadEvents(ticket.thread_id) : Promise.resolve([] as ThreadEventView[]),
    loadTicketAnswers(ticket.ticket_id),
    ticket.thread_id ? loadCollaborators(ticket.thread_id) : Promise.resolve([]),
  ]);

  const timeline = sortTimeline([...entries, ...(await withEventRefs(events))]);
  const order = agent.config.str("thread_view_order") || cfg.str("thread_view_order", "ASC");
  if (order === "DESC") timeline.reverse();

  const assignee = ticket.staff_id ? await formatAgentName(ticket.staff_first, ticket.staff_last) : "";
  const role = roleOn(ticket, agent);

  // scheda "Task" della vista ticket (ticket-view.inc.php): task collegati al ticket
  const taskRow = await db()
    .selectFrom("task")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("object_type", "=", ObjectType.TICKET)
    .where("object_id", "=", ticket.ticket_id)
    .executeTakeFirst();
  const taskCount = Number(taskRow?.n ?? 0);
  const { rows: tasks } = taskCount
    ? await listTasks(agent, { queue: "open", ticketId: ticket.ticket_id, page: 1, pageSize: 50 })
    : { rows: [] as TaskRow[] };

  // Composer: stati ammessi (aperti; chiusi solo con permesso di chiusura), firma, risposte predefinite
  const canClose = role.perms.has(TicketPerm.CLOSE);
  const [statusList, cannedList, me, dept] = await Promise.all([
    db()
      .selectFrom("ticket_status")
      .select(["id", "name", "state"])
      .where("state", "in", canClose ? ["open", "closed"] : ["open"])
      // solo stati abilitati, come la select del PHP (isEnabled) e isSelectableStatus lato server
      .where((eb) => eb(eb("mode", "&", TicketStatus.ENABLED), "!=", 0))
      .orderBy("sort")
      .orderBy("name")
      .execute(),
    listCanned(agent),
    db().selectFrom("staff").select(["signature", "default_signature_type"]).where("staff_id", "=", agent.id).executeTakeFirst(),
    db().selectFrom("department").select(["signature", "ispublic"]).where("id", "=", ticket.dept_id).executeTakeFirst(),
  ]);

  return {
    ticket,
    role,
    tz,
    iframeWhitelist,
    timeline,
    assignee,
    legacyUrl: process.env.OST_PHP_URL,
    taskCount,
    tasks,
    collaborators,
    answers,
    composer: {
      ticketId: ticket.ticket_id,
      canReply: role.perms.has(TicketPerm.REPLY),
      lockMode: cfg.int("autolock_minutes") > 0 ? cfg.int("ticket_lock", 2) : 0,
      statuses: statusList.map((s) => ({ id: s.id, name: s.name, state: s.state ?? "" })),
      currentStatusId: ticket.status_id,
      collaborators: collaborators.map((c) => ({ userId: c.user_id, name: c.name, email: c.email ?? "", active: c.active })),
      canned: cannedList.map((c) => ({ id: c.canned_id, title: c.title })),
      hasMySignature: !!me?.signature,
      deptSignature: !!(dept?.signature && dept.ispublic),
      defaultSignature: me?.default_signature_type ?? "none",
      uploadUrl: cfg.bool("allow_attachments") ? "/api/agent/upload" : undefined,
      maxFileSize: cfg.int("max_file_size"),
    },
  };
}

/** Numero del ticket per il titolo della pagina (null se inesistente). */
export async function ticketViewNumber(agent: Agent, ticketId: number): Promise<string | null> {
  // stesso controllo della vista: il numero non si rivela a chi non può vedere il ticket
  const ticket = await loadTicket(ticketId, agent.id);
  return ticket && (await checkStaffPerm(ticket, agent)) ? ticket.number : null;
}

const REF_KINDS = ["staff", "team", "dept", "status"] as const;

/** Nomi degli oggetti citati negli eventi (assegnatari, team, reparti, stati). */
async function withEventRefs(events: ThreadEventView[]): Promise<TimelineEvent[]> {
  const ids = { staff: new Set<number>(), team: new Set<number>(), dept: new Set<number>(), status: new Set<number>() };
  for (const ev of events) {
    for (const k of REF_KINDS) {
      const v = ev.data[k];
      if (typeof v === "number" || (typeof v === "string" && /^\d+$/.test(v))) ids[k].add(Number(v));
    }
  }
  const [staffRows, teamRows, deptRows, statusRows] = await Promise.all([
    ids.staff.size ? db().selectFrom("staff").select(["staff_id", "firstname", "lastname"]).where("staff_id", "in", [...ids.staff]).execute() : [],
    ids.team.size ? db().selectFrom("team").select(["team_id", "name"]).where("team_id", "in", [...ids.team]).execute() : [],
    ids.dept.size ? db().selectFrom("department").select(["id", "name"]).where("id", "in", [...ids.dept]).execute() : [],
    ids.status.size ? db().selectFrom("ticket_status").select(["id", "name"]).where("id", "in", [...ids.status]).execute() : [],
  ]);
  const staffName = new Map<number, string>();
  for (const s of staffRows) staffName.set(s.staff_id, await formatAgentName(s.firstname, s.lastname));
  const names: Record<(typeof REF_KINDS)[number], Map<number, string>> = {
    staff: staffName,
    team: new Map(teamRows.map((r) => [r.team_id, r.name])),
    dept: new Map(deptRows.map((r) => [r.id, r.name])),
    status: new Map(statusRows.map((r) => [r.id, r.name])),
  };
  return events.map((ev) => ({
    ...ev,
    refs: {
      staff: names.staff.get(Number(ev.data.staff)) ?? "",
      team: names.team.get(Number(ev.data.team)) ?? "",
      dept: names.dept.get(Number(ev.data.dept)) ?? "",
      status: names.status.get(Number(ev.data.status)) ?? "",
    },
  }));
}

/** Timeline: entry ed eventi in ordine cronologico (a parità di istante prima l'evento, es. "Creato"). */
function sortTimeline(items: TimelineItem[]): TimelineItem[] {
  return items.sort((a, x) => {
    const ta = a.kind === "entry" ? a.created : a.timestamp;
    const tx = x.kind === "entry" ? x.created : x.timestamp;
    if (ta !== tx) return ta < tx ? -1 : 1;
    return a.kind === x.kind ? 0 : a.kind === "event" ? -1 : 1;
  });
}
