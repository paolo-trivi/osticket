import "server-only";

import { sql } from "kysely";

import { Collaborator as CollaboratorFlag } from "@/lib/osticket/flags";
import { AttachmentType, ObjectType } from "@/lib/osticket/object-types";

import { db, table, type DbOrTx } from "../../db";
import type { DbDateTime } from "../../db/schema.gen";
import { phpJsonDecode } from "../../format/php-json";
import type { Agent, RoleInfo } from "../staff/staff";
import { loadTicketRows, type TicketRow } from "./rows";

/** Ticket con tutto ciò che serve a vista e permessi (Ticket.php). */
export interface TicketDetail extends TicketRow {
  thread_id: number | null;
  topic_id: number;
  sla_id: number;
  reopened: DbDateTime | null;
  ip_address: string;
  user_phone: string | null;
  lock_id: number;
}

export async function loadTicket(ticketId: number, viewerStaffId: number, executor: DbOrTx = db()): Promise<TicketDetail | null> {
  const [row] = await loadTicketRows([ticketId], viewerStaffId, executor);
  if (!row) return null;
  const extra = await executor
    .selectFrom("ticket as t")
    .leftJoin("thread as th", (j) => j.onRef("th.object_id", "=", "t.ticket_id").on("th.object_type", "=", ObjectType.TICKET))
    .leftJoin("user__cdata as uc", "uc.user_id", "t.user_id")
    .select(["th.id as thread_id", "t.topic_id", "t.sla_id", "t.reopened", "t.ip_address", "t.lock_id"])
    .select(sql<string | null>`uc.phone`.as("user_phone"))
    .where("t.ticket_id", "=", ticketId)
    .executeTakeFirst()
    .catch(async () =>
      // user__cdata può non esistere finché il PHP non la materializza
      executor
        .selectFrom("ticket as t")
        .leftJoin("thread as th", (j) => j.onRef("th.object_id", "=", "t.ticket_id").on("th.object_type", "=", ObjectType.TICKET))
        .select(["th.id as thread_id", "t.topic_id", "t.sla_id", "t.reopened", "t.ip_address", "t.lock_id"])
        .select(sql<null>`NULL`.as("user_phone"))
        .where("t.ticket_id", "=", ticketId)
        .executeTakeFirst(),
    );
  if (!extra) return null;
  return { ...row, ...extra, thread_id: extra.thread_id ?? null } as TicketDetail;
}

async function referralsOf(threadId: number | null, executor: DbOrTx) {
  if (!threadId) return [];
  return executor
    .selectFrom("thread_referral")
    .select(["object_id", "object_type"])
    .where("thread_id", "=", threadId)
    .execute();
}

/** Ticket::isAssigned($staff): solo se aperto; agente assegnato o membro del team assegnato. */
function isAssignedTo(t: TicketDetail, agent: Agent): boolean {
  if (t.status_state !== "open") return false;
  return t.staff_id === agent.id || agent.isTeamMember(t.team_id);
}

/** Thread::isReferred($staff): referral all'agente, a un suo reparto o a un suo team. */
async function isReferredTo(t: TicketDetail, agent: Agent, executor: DbOrTx = db()): Promise<boolean> {
  const refs = await referralsOf(t.thread_id, executor);
  return refs.some(
    (r) =>
      (r.object_type === ObjectType.STAFF && r.object_id === agent.id) ||
      (r.object_type === ObjectType.DEPT && agent.deptIds.includes(r.object_id)) ||
      (r.object_type === ObjectType.TEAM && agent.teamIds.includes(r.object_id)),
  );
}

/** Ticket::checkStaffPerm($staff, $perm): accesso al reparto, assegnazione o referral; poi permesso del ruolo. */
export async function checkStaffPerm(t: TicketDetail, agent: Agent, perm?: string, executor: DbOrTx = db()): Promise<boolean> {
  const canView = agent.canAccessDept(t.dept_id) || isAssignedTo(t, agent) || (await isReferredTo(t, agent, executor));
  if (!canView) return false;
  if (!perm) return true;
  return roleOn(t, agent).perms.has(perm);
}

export function roleOn(t: TicketDetail, agent: Agent): RoleInfo {
  return agent.roleFor(t.dept_id, isAssignedTo(t, agent));
}

// --- Thread ----------------------------------------------------------------------

export interface ThreadAttachment {
  id: number;
  file_id: number;
  name: string;
  size: number;
  type: string;
  key: string;
  inline: boolean;
}

export interface ThreadEntryView {
  kind: "entry";
  id: number;
  pid: number;
  type: "M" | "R" | "N";
  poster: string;
  staff_id: number;
  user_id: number;
  title: string | null;
  body: string;
  format: string;
  source: string;
  created: DbDateTime;
  updated: DbDateTime;
  flags: number;
  editor_name: string | null;
  attachments: ThreadAttachment[];
  recipients: Record<string, unknown> | null;
}

export interface ThreadEventView {
  kind: "event";
  id: number;
  name: string;
  timestamp: DbDateTime;
  username: string;
  data: Record<string, unknown>;
  staff_id: number;
  team_id: number;
  dept_id: number;
  staff_name: string | null;
  team_name: string | null;
  dept_name: string | null;
}

/** Messaggi, risposte e note del thread (ThreadEntry) con allegati, in ordine cronologico. */
export async function loadThreadEntries(threadId: number, executor: DbOrTx = db()): Promise<ThreadEntryView[]> {
  const entries = await executor
    .selectFrom("thread_entry as e")
    .leftJoin("staff as ed", (j) => j.onRef("ed.staff_id", "=", "e.editor").on("e.editor_type", "=", ObjectType.STAFF))
    .select([
      "e.id",
      "e.pid",
      "e.type",
      "e.poster",
      "e.staff_id",
      "e.user_id",
      "e.title",
      "e.body",
      "e.format",
      "e.source",
      "e.created",
      "e.updated",
      "e.flags",
      "e.recipients",
    ])
    .select(sql<string | null>`CONCAT_WS(' ', ed.firstname, ed.lastname)`.as("editor_name"))
    .where("e.thread_id", "=", threadId)
    .orderBy("e.created")
    .orderBy("e.id")
    .execute();
  const ids = entries.map((e) => e.id);
  const atts = ids.length
    ? await executor
        .selectFrom("attachment as a")
        .innerJoin("file as f", "f.id", "a.file_id")
        .select(["a.id", "a.object_id", "a.file_id", "a.inline", "a.name", "f.name as fname", "f.size", "f.type", "f.key"])
        .where("a.type", "=", AttachmentType.THREAD_ENTRY)
        .where("a.object_id", "in", ids)
        .execute()
    : [];
  return entries.map((e) => ({
    kind: "entry" as const,
    id: e.id,
    pid: e.pid,
    type: e.type as "M" | "R" | "N",
    poster: e.poster ?? "",
    staff_id: e.staff_id,
    user_id: e.user_id,
    title: e.title,
    body: e.body,
    format: e.format,
    source: e.source,
    created: e.created,
    updated: e.updated,
    flags: e.flags,
    editor_name: e.editor_name?.trim() || null,
    recipients: phpJsonDecode(e.recipients, null),
    attachments: atts
      .filter((a) => a.object_id === e.id)
      .map((a) => ({
        id: a.id,
        file_id: a.file_id,
        name: a.name || a.fname,
        size: Number(a.size),
        type: a.type,
        key: a.key,
        inline: !!a.inline,
      })),
  }));
}

/** Eventi del thread (thread_event + event), esclusi quelli annullati, come la timeline di osTicket. */
export async function loadThreadEvents(threadId: number, executor: DbOrTx = db()): Promise<ThreadEventView[]> {
  const { rows } = await sql<{
    id: number;
    name: string;
    timestamp: DbDateTime;
    username: string;
    data: string | null;
    staff_id: number;
    team_id: number;
    dept_id: number;
    staff_name: string | null;
    team_name: string | null;
    dept_name: string | null;
  }>`
    SELECT V.id, EV.name, V.timestamp,
      -- ThreadEvent::getUserName(): nome dell'agente o dell'utente autore, altrimenti username
      COALESCE(
        CASE WHEN V.uid_type = 'S' THEN NULLIF(CONCAT_WS(' ', AU.firstname, AU.lastname), '') END,
        CASE WHEN V.uid_type = 'U' THEN UU.name END,
        V.username) AS username,
      V.data, V.staff_id, V.team_id, V.dept_id,
      NULLIF(CONCAT_WS(' ', S.firstname, S.lastname), '') AS staff_name, TM.name AS team_name, D.name AS dept_name
    FROM ${table("thread_event")} V
    JOIN ${table("event")} EV ON (EV.id = V.event_id)
    LEFT JOIN ${table("staff")} S ON (S.staff_id = V.staff_id)
    LEFT JOIN ${table("team")} TM ON (TM.team_id = V.team_id)
    LEFT JOIN ${table("department")} D ON (D.id = V.dept_id)
    LEFT JOIN ${table("staff")} AU ON (V.uid_type = 'S' AND AU.staff_id = V.uid)
    LEFT JOIN ${table("user")} UU ON (V.uid_type = 'U' AND UU.id = V.uid)
    WHERE V.thread_id = ${threadId} AND V.annulled = 0
    ORDER BY V.timestamp, V.id`.execute(executor);
  return rows.map((r) => ({ kind: "event" as const, ...r, data: phpJsonDecode(r.data, {}) ?? {} }));
}

interface FormAnswer {
  form_title: string;
  label: string;
  name: string;
  type: string;
  value: string | null;
}

/** Dati dei form dinamici del ticket (form_entry 'T' + valori), escluso il form base già mostrato. */
export async function loadTicketAnswers(ticketId: number, executor: DbOrTx = db()): Promise<FormAnswer[]> {
  const { rows } = await sql<FormAnswer>`
    SELECT F.title AS form_title, FF.label, FF.name, FF.type, V.value
    FROM ${table("form_entry")} FE
    JOIN ${table("form")} F ON (F.id = FE.form_id)
    JOIN ${table("form_entry_values")} V ON (V.entry_id = FE.id)
    JOIN ${table("form_field")} FF ON (FF.id = V.field_id)
    WHERE FE.object_type = 'T' AND FE.object_id = ${ticketId}
      AND FF.name NOT IN ('subject', 'message', 'priority') AND FF.type NOT IN ('break', 'info', 'thread')
    ORDER BY FE.sort, FF.sort`.execute(executor);
  return rows;
}

interface Collaborator {
  id: number;
  user_id: number;
  name: string;
  email: string | null;
  active: boolean;
  role: string;
}

export async function loadCollaborators(threadId: number, executor: DbOrTx = db()): Promise<Collaborator[]> {
  const rows = await executor
    .selectFrom("thread_collaborator as c")
    .innerJoin("user as u", "u.id", "c.user_id")
    .leftJoin("user_email as ue", "ue.id", "u.default_email_id")
    .select(["c.id", "c.user_id", "u.name", "ue.address as email", "c.flags", "c.role"])
    .where("c.thread_id", "=", threadId)
    .execute();
  return rows.map((r) => ({ id: r.id, user_id: r.user_id, name: r.name, email: r.email, active: (r.flags & CollaboratorFlag.ACTIVE) !== 0, role: r.role }));
}
