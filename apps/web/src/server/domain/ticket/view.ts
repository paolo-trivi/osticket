import "server-only";

import { SLA, TicketStatus, ThreadEntry } from "@/lib/osticket/flags";
import { ObjectType } from "@/lib/osticket/object-types";

import { coreConfig } from "../../config/config";
import { db } from "../../db";
import { agentTimeZone } from "../../format/datetime";
import { listCanned } from "../kb/kb";
import { TicketPerm, type Agent, type RoleInfo } from "../staff/staff";
import { plainLabel } from "../forms/fields";
import { listTasks, type TaskRow } from "../task/tasks";
import { EDIT_EVENT_COLUMNS, eventCollabs, eventPair, eventRef, eventValueText, type EditEventColumn } from "./event-refs";
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

/** Modifica descritta da EditEvent: colonna del ticket (`column`) o campo dei form (`label`). */
export interface ThreadEventChange {
  column: EditEventColumn | null;
  label: string;
  old: string;
  new: string;
}

/**
 * Nomi degli oggetti citati da un evento del thread (assegnatario, team, reparto, stato…); "" se assente.
 * I campi facoltativi li calcola solo la vista ticket (la timeline dei task usa i quattro di base).
 */
export interface ThreadEventRefs {
  staff: string;
  team: string;
  dept: string;
  status: string;
  /** EditEvent `owner` (User) */
  owner?: string;
  /** CollaboratorEvent `org` (Organization) */
  org?: string;
  /** CollaboratorEvent: aggiunti (con l'origine) e rimossi */
  collabAdded?: { name: string; src: string }[];
  collabRemoved?: string[];
  /** EditEvent `fields` / topic_id / sla_id / duedate / user_id / source */
  changes?: ThreadEventChange[];
  /** sla_id: [nome, ore di tolleranza, attivo] per la descrizione dello SLA come SLA::getSLAs() */
  slas?: Record<string, { name: string; hours: number; active: boolean }>;
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
  collaborators: {
    userId: number;
    name: string;
    email: string;
    active: boolean;
  }[];
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

/**
 * Esito di assegnazione, trasferimento o cambio di stato mostrato nella lista dopo il ritorno dalla vista
 * (il messaggio di sessione di scp/tickets.php): dati attuali del ticket, solo se l'agente lo vede ancora.
 */
export async function ticketDoneSummary(
  agent: Agent,
  ticketId: number,
): Promise<{
  number: string;
  dept: string;
  assignee: string;
  status: string;
} | null> {
  const ticket = await loadTicket(ticketId, agent.id);
  if (!ticket || !(await checkStaffPerm(ticket, agent))) return null;
  const staff = ticket.staff_id ? await formatAgentName(ticket.staff_first, ticket.staff_last) : "";
  return {
    number: ticket.number,
    dept: ticket.dept_name ?? "",
    assignee: staff || ticket.team_name || "",
    status: ticket.status_name,
  };
}

const REF_KINDS = ["staff", "team", "dept", "status"] as const;

/** Nomi degli oggetti citati negli eventi (ThreadEvent::template: `{<Tipo>data.x}` con id o [id, nome]). */
export async function withEventRefs(events: ThreadEventView[]): Promise<TimelineEvent[]> {
  const ids = {
    staff: new Set<number>(),
    team: new Set<number>(),
    dept: new Set<number>(),
    status: new Set<number>(),
  };
  const users = new Set<number>();
  const topics = new Set<number>();
  const slas = new Set<number>();
  const fields = new Set<number>();
  const orgs = new Set<number>();
  const add = (set: Set<number>, v: unknown) => {
    const { id } = eventRef(v);
    if (id) set.add(id);
  };
  for (const ev of events) {
    const d = ev.data;
    for (const k of REF_KINDS) add(ids[k], d[k]);
    if (ev.name === "collab") {
      add(orgs, d.org);
      const { added, removed } = eventCollabs(d);
      for (const c of [...added, ...removed]) if (c.id) users.add(c.id);
    }
    if (ev.name !== "edited") continue;
    add(users, d.owner);
    for (const v of eventPair(d.user_id)) add(users, v);
    for (const v of eventPair(d.topic_id)) add(topics, v);
    for (const v of eventPair(d.sla_id)) add(slas, v);
    if (d.fields && typeof d.fields === "object") for (const k of Object.keys(d.fields)) add(fields, k);
  }
  const ex = db();
  const [staffRows, teamRows, deptRows, statusRows, userRows, topicRows, slaRows, fieldRows, orgRows] = await Promise.all([
    ids.staff.size
      ? ex
          .selectFrom("staff")
          .select(["staff_id", "firstname", "lastname"])
          .where("staff_id", "in", [...ids.staff])
          .execute()
      : [],
    ids.team.size
      ? ex
          .selectFrom("team")
          .select(["team_id", "name"])
          .where("team_id", "in", [...ids.team])
          .execute()
      : [],
    ids.dept.size
      ? ex
          .selectFrom("department")
          .select(["id", "name"])
          .where("id", "in", [...ids.dept])
          .execute()
      : [],
    ids.status.size
      ? ex
          .selectFrom("ticket_status")
          .select(["id", "name"])
          .where("id", "in", [...ids.status])
          .execute()
      : [],
    users.size
      ? ex
          .selectFrom("user")
          .select(["id", "name"])
          .where("id", "in", [...users])
          .execute()
      : [],
    // Topic::getTopicName: nome completo con i genitori
    topics.size ? ex.selectFrom("help_topic").select(["topic_id", "topic_pid", "topic"]).execute() : [],
    slas.size
      ? ex
          .selectFrom("sla")
          .select(["id", "name", "grace_period", "flags"])
          .where("id", "in", [...slas])
          .execute()
      : [],
    fields.size
      ? ex
          .selectFrom("form_field")
          .select(["id", "label"])
          .where("id", "in", [...fields])
          .execute()
      : [],
    orgs.size
      ? ex
          .selectFrom("organization")
          .select(["id", "name"])
          .where("id", "in", [...orgs])
          .execute()
      : [],
  ]);
  const staffName = new Map<number, string>();
  for (const s of staffRows) staffName.set(s.staff_id, await formatAgentName(s.firstname, s.lastname));
  const names: Record<(typeof REF_KINDS)[number], Map<number, string>> = {
    staff: staffName,
    team: new Map(teamRows.map((r) => [r.team_id, r.name])),
    dept: new Map(deptRows.map((r) => [r.id, r.name])),
    status: new Map(statusRows.map((r) => [r.id, r.name])),
  };
  const userName = new Map(userRows.map((r) => [r.id, r.name]));
  const topicById = new Map(topicRows.map((r) => [r.topic_id, r]));
  const topicName = (id: number) => {
    const parts: string[] = [];
    for (let t = topicById.get(id), n = 0; t && n < 10; t = t.topic_pid ? topicById.get(t.topic_pid) : undefined, n++) parts.unshift(t.topic);
    return parts.join(" / ");
  };
  const slaInfo = Object.fromEntries(slaRows.map((r) => [String(r.id), { name: r.name, hours: r.grace_period, active: !!(r.flags & SLA.ACTIVE) }]));
  const fieldLabel = new Map(fieldRows.map((r) => [r.id, plainLabel(r.label ?? "")]));
  const orgName = new Map(orgRows.map((r) => [r.id, r.name]));
  // `{<Tipo>data.x}`: nome attuale, altrimenti il nome registrato nell'evento
  const ref = (map: Map<number, string>, v: unknown) => {
    const { id, fallback } = eventRef(v);
    return (id ? map.get(id) : undefined) || fallback;
  };

  return events.map((ev) => {
    const d = ev.data;
    const collabs = ev.name === "collab" ? eventCollabs(d) : { added: [], removed: [] };
    const changes: ThreadEventChange[] = [];
    if (ev.name === "edited") {
      if (d.fields && typeof d.fields === "object") {
        for (const [k, pair] of Object.entries(d.fields as Record<string, unknown>)) {
          // campi inesistenti (es. "Ticket Owner" del cambio di proprietario) saltati come nel PHP
          const label = fieldLabel.get(Number(k));
          if (!label) continue;
          const [o, n] = eventPair(pair);
          changes.push({
            column: null,
            label,
            old: eventValueText(o),
            new: eventValueText(n),
          });
        }
      }
      for (const col of EDIT_EVENT_COLUMNS) {
        if (!(col in d)) continue;
        const [o, n] = eventPair(d[col]);
        const show = (v: unknown) => (col === "topic_id" ? (eventRef(v).id ? topicName(eventRef(v).id!) : "") : col === "user_id" ? ref(userName, v) : eventValueText(v));
        changes.push({ column: col, label: col, old: show(o), new: show(n) });
      }
    }
    return {
      ...ev,
      refs: {
        staff: ref(names.staff, d.staff),
        team: ref(names.team, d.team),
        dept: ref(names.dept, d.dept),
        status: ref(names.status, d.status),
        owner: ref(userName, d.owner),
        org: ref(orgName, d.org),
        collabAdded: collabs.added.map((c) => ({
          name: (c.id ? userName.get(c.id) : undefined) || c.name,
          src: c.src,
        })),
        collabRemoved: collabs.removed.map((c) => (c.id ? userName.get(c.id) : undefined) || c.name),
        changes,
        slas: slaInfo,
      },
    };
  });
}

/** Timeline: entry ed eventi in ordine cronologico (a parità di istante prima l'evento, es. "Creato"). */
export function sortTimeline(items: TimelineItem[]): TimelineItem[] {
  return items.sort((a, x) => {
    const ta = a.kind === "entry" ? a.created : a.timestamp;
    const tx = x.kind === "entry" ? x.created : x.timestamp;
    if (ta !== tx) return ta < tx ? -1 : 1;
    return a.kind === x.kind ? 0 : a.kind === "event" ? -1 : 1;
  });
}
