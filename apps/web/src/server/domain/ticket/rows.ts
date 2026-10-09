import "server-only";

import { sql } from "kysely";

import { coreConfig } from "../../config/config";
import { db, table, type DbOrTx } from "../../db";
import type { DbDateTime } from "../../db/schema.gen";

/** Dati di una riga di coda: tutto ciò che servono le colonne e le decorazioni standard di osTicket. */
export interface TicketRow {
  ticket_id: number;
  number: string;
  subject: string;
  source: string;
  created: DbDateTime;
  lastupdate: DbDateTime | null;
  closed: DbDateTime | null;
  duedate: DbDateTime | null;
  est_duedate: DbDateTime | null;
  isoverdue: boolean;
  isanswered: boolean;
  flags: number;
  ticket_pid: number | null;
  user_id: number;
  user_name: string;
  user_email: string;
  org_name: string | null;
  priority_id: number | null;
  priority: string | null;
  priority_color: string | null;
  priority_urgency: number | null;
  status_id: number;
  status_name: string;
  status_state: string;
  dept_id: number;
  dept_name: string | null;
  staff_id: number;
  staff_first: string | null;
  staff_last: string | null;
  team_id: number;
  team_name: string | null;
  topic_name: string | null;
  sla_name: string | null;
  lastmessage: DbDateTime | null;
  lastresponse: DbDateTime | null;
  thread_count: number;
  attachment_count: number;
  collaborator_count: number;
  task_count: number;
  /** bloccato da un altro agente (LockDecoration) */
  locked_by_other: boolean;
}

export async function loadTicketRows(ids: number[], viewerStaffId: number, executor: DbOrTx = db()): Promise<TicketRow[]> {
  if (!ids.length) return [];
  const { rows } = await sql<TicketRow>`
    SELECT T.ticket_id, T.number, CD.subject, T.source, T.created, T.lastupdate, T.closed, T.duedate, T.est_duedate,
      T.isoverdue, T.isanswered, T.flags, T.ticket_pid, T.user_id,
      U.name AS user_name, UE.address AS user_email, ORG.name AS org_name,
      PR.priority_id, PR.priority_desc AS priority, PR.priority_color, PR.priority_urgency,
      T.status_id, ST.name AS status_name, ST.state AS status_state,
      T.dept_id, D.name AS dept_name, T.staff_id, S.firstname AS staff_first, S.lastname AS staff_last,
      T.team_id, TM.name AS team_name, HT.topic AS topic_name, SL.name AS sla_name,
      TH.lastmessage, TH.lastresponse,
      (SELECT COUNT(*) FROM ${table("thread_entry")} E WHERE E.thread_id = TH.id AND E.type IN ('M','R')) AS thread_count,
      (SELECT COUNT(*) FROM ${table("thread_entry")} E JOIN ${table("attachment")} A ON (A.object_id = E.id AND A.type = 'H' AND A.inline = 0)
         WHERE E.thread_id = TH.id) AS attachment_count,
      (SELECT COUNT(*) FROM ${table("thread_collaborator")} C WHERE C.thread_id = TH.id) AS collaborator_count,
      (SELECT COUNT(*) FROM ${table("task")} K WHERE K.object_id = T.ticket_id AND K.object_type = 'T') AS task_count,
      (LK.lock_id IS NOT NULL AND LK.staff_id <> ${viewerStaffId} AND LK.expire > NOW()) AS locked_by_other
    FROM ${table("ticket")} T
    INNER JOIN ${table("ticket_status")} ST ON (ST.id = T.status_id)
    LEFT JOIN ${table("ticket__cdata")} CD ON (CD.ticket_id = T.ticket_id)
    LEFT JOIN ${table("ticket_priority")} PR ON (PR.priority_id = CD.priority)
    LEFT JOIN ${table("thread")} TH ON (TH.object_id = T.ticket_id AND TH.object_type = 'T')
    LEFT JOIN ${table("user")} U ON (U.id = T.user_id)
    LEFT JOIN ${table("user_email")} UE ON (UE.id = U.default_email_id)
    LEFT JOIN ${table("organization")} ORG ON (ORG.id = U.org_id)
    LEFT JOIN ${table("department")} D ON (D.id = T.dept_id)
    LEFT JOIN ${table("staff")} S ON (S.staff_id = T.staff_id)
    LEFT JOIN ${table("team")} TM ON (TM.team_id = T.team_id)
    LEFT JOIN ${table("help_topic")} HT ON (HT.topic_id = T.topic_id)
    LEFT JOIN ${table("sla")} SL ON (SL.id = T.sla_id)
    LEFT JOIN ${table("lock")} LK ON (LK.lock_id = T.lock_id)
    WHERE T.ticket_id IN (${sql.join(ids)})`.execute(executor);

  const byId = new Map(
    rows.map((r) => [
      Number(r.ticket_id),
      {
        ...r,
        ticket_id: Number(r.ticket_id),
        subject: r.subject ?? "",
        isoverdue: !!Number(r.isoverdue),
        isanswered: !!Number(r.isanswered),
        locked_by_other: !!Number(r.locked_by_other),
        thread_count: Number(r.thread_count),
        attachment_count: Number(r.attachment_count),
        collaborator_count: Number(r.collaborator_count),
        task_count: Number(r.task_count),
      },
    ]),
  );
  return ids.map((id) => byId.get(id)).filter((r): r is TicketRow => !!r);
}

/** Formato del nome agente secondo core.agent_name_format (PersonsName). */
export async function formatAgentName(first: string | null, last: string | null): Promise<string> {
  const fmt = (await coreConfig()).str("agent_name_format", "full");
  const f = first ?? "";
  const l = last ?? "";
  switch (fmt) {
    case "last":
    case "lastfirst":
      return [l, f].filter(Boolean).join(", ");
    case "first":
      return f || l;
    case "short":
      return `${f}${l ? " " + l[0] + "." : ""}`;
    case "shortformal":
      return `${f ? f[0] + ". " : ""}${l}`;
    default:
      return `${f} ${l}`.trim();
  }
}
