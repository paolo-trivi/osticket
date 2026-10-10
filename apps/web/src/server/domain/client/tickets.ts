import "server-only";

import { sql, type SqlBool } from "kysely";

import { Ticket } from "@/lib/osticket/flags";
import { ObjectType } from "@/lib/osticket/object-types";

import type { ConfigNamespace } from "../../config/config";
import { db, table, type DbOrTx } from "../../db";
import { buildMatch } from "../queue/search";
import { mergeTypeOf } from "../ticket/merge-flags";
import type { ClientIdentity } from "./identity";

/**
 * Ticket del portale clienti: accesso (Ticket::checkUserAccess), visibilità e lista
 * (EndUser/tickets.inc.php), contatori. La vista è in ./ticket-view, la modifica dei campi in ./ticket-edit.
 */

/** Ticket::checkUserAccess($thisclient) */
export async function clientCanAccess(client: ClientIdentity, ticketId: number, executor: DbOrTx = db()): Promise<boolean> {
  const t = await executor
    .selectFrom("ticket as t")
    .innerJoin("user as u", "u.id", "t.user_id")
    .leftJoin("thread as th", (j) => j.onRef("th.object_id", "=", "t.ticket_id").on("th.object_type", "=", ObjectType.TICKET))
    .select(["t.ticket_id", "t.user_id", "t.flags", "u.org_id", "th.id as thread_id"])
    .where("t.ticket_id", "=", ticketId)
    .executeTakeFirst();
  if (!t) return false;
  // Ospite (link): solo il ticket del link (il PHP rimanda sempre a quel ticket in tickets.php)
  if (client.guest && client.guest.ticketId !== ticketId) return false;
  if (t.user_id === client.id) return true;
  if (client.canSeeOrgTickets && t.org_id && t.org_id === client.orgId) return true;
  if (client.guest && client.guest.collabId && client.guest.ticketId === ticketId) return true;
  if (t.thread_id) {
    const c = await executor.selectFrom("thread_collaborator").select("id").where("thread_id", "=", t.thread_id).where("user_id", "=", client.id).executeTakeFirst();
    if (c) return true;
  }
  // Ticket padre di un merge non "visual": accesso tramite uno dei figli
  if (t.flags & Ticket.PARENT && mergeTypeOf(t.flags) !== "visual") {
    const children = await executor.selectFrom("ticket").select("ticket_id").where("ticket_pid", "=", t.ticket_id).orderBy("sort").execute();
    for (const ch of children) if (await clientCanAccess({ ...client, guest: null }, ch.ticket_id, executor)) return true;
  }
  return false;
}

export type ClientSort = "id" | "subject" | "status" | "dept" | "date";

interface ClientTicketQuery {
  status?: "open" | "closed";
  topicId?: number;
  keywords?: string;
  sort?: ClientSort;
  order?: "ASC" | "DESC";
  page?: number;
  pageSize?: number;
}

interface ClientTicketRow {
  id: number;
  number: string;
  created: string;
  isanswered: number;
  source: string;
  statusName: string;
  state: string;
  subject: string;
  dept: string;
}

/** Visibilità dei ticket per il cliente (unione proprietario / collaboratore / organizzazione) */
function visibility(cfg: ConfigNamespace, client: ClientIdentity) {
  const parts = [sql<SqlBool>`T.user_id = ${client.id}`];
  if (cfg.bool("collaborator_ticket_visibility")) {
    parts.push(sql<SqlBool>`T.ticket_id IN (SELECT TH.object_id FROM ${table("thread")} TH JOIN ${table("thread_collaborator")} C ON (C.thread_id = TH.id)
      WHERE TH.object_type = 'T' AND C.user_id = ${client.id})`);
  }
  if (client.canSeeOrgTickets && client.orgId) {
    parts.push(sql<SqlBool>`T.user_id IN (SELECT id FROM ${table("user")} WHERE org_id = ${client.orgId})`);
  }
  return sql<SqlBool>`(${sql.join(parts, sql` OR `)})`;
}

/**
 * Lista dei ticket (include/client/tickets.inc.php): filtro di stato (aperti se non indicato, come il
 * `switch` senza break del PHP), help topic, ricerca (numero per prefisso, altrimenti indice full-text
 * senza le note interne), ordinamento per numero/oggetto/stato/reparto/data.
 */
export async function listClientTickets(cfg: ConfigNamespace, client: ClientIdentity, q: ClientTicketQuery, executor: DbOrTx = db()) {
  const status = q.status === "closed" ? "closed" : "open";
  const where = [visibility(cfg, client), sql<SqlBool>`S.state = ${status}`];
  if (q.topicId) where.push(sql<SqlBool>`T.topic_id = ${q.topicId}`);
  if (client.guest) where.push(sql<SqlBool>`T.ticket_id = ${client.guest.ticketId}`);
  const kw = (q.keywords ?? "").trim();
  if (kw) {
    if (/^\d+$/.test(kw)) where.push(sql<SqlBool>`T.number LIKE ${`${kw}%`}`);
    else if (kw.length > 2) {
      const m = buildMatch(kw, false);
      if (m) {
        const match = sql`MATCH (Z.title, Z.content) AGAINST (${m.query} IN NATURAL LANGUAGE MODE)`;
        // Indice: dati del ticket o voci del thread visibili al cliente (le note interne sono escluse)
        where.push(sql<SqlBool>`T.ticket_id IN (
          SELECT Z.object_id FROM ${table("_search")} Z WHERE Z.object_type = 'T' AND ${match}
          UNION SELECT TH.object_id FROM ${table("_search")} Z JOIN ${table("thread_entry")} E ON (Z.object_type = 'H' AND E.id = Z.object_id)
            JOIN ${table("thread")} TH ON (TH.id = E.thread_id AND TH.object_type = 'T') WHERE E.type IN ('M','R') AND ${match})`);
      }
    }
  }
  const SORT: Record<ClientSort, string> = { id: "T.number", subject: "CD.subject", status: "S.name", dept: "D.name", date: "T.created" };
  const sortCol = sql.raw(SORT[q.sort ?? "date"] ?? "T.created");
  const dir = sql.raw(q.order === "ASC" ? "ASC" : "DESC");
  const pageSize = q.pageSize ?? 25;
  const page = Math.max(1, q.page ?? 1);
  const cond = sql.join(where, sql` AND `);
  const { rows } = await sql<{ ticket_id: number; number: string; created: string; isanswered: number; source: string; sname: string; state: string; subject: string | null; dept: string | null }>`
    SELECT T.ticket_id, T.number, T.created, T.isanswered, T.source, S.name AS sname, S.state, CD.subject, D.name AS dept
    FROM ${table("ticket")} T
    JOIN ${table("ticket_status")} S ON (S.id = T.status_id)
    LEFT JOIN ${table("ticket__cdata")} CD ON (CD.ticket_id = T.ticket_id)
    LEFT JOIN ${table("department")} D ON (D.id = T.dept_id)
    WHERE ${cond}
    ORDER BY ${sortCol} ${dir}, T.ticket_id DESC
    LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`.execute(executor);
  const { rows: count } = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM ${table("ticket")} T JOIN ${table("ticket_status")} S ON (S.id = T.status_id) WHERE ${cond}`.execute(executor);
  const items: ClientTicketRow[] = rows.map((r) => ({
    id: r.ticket_id,
    number: r.number,
    created: r.created,
    isanswered: r.isanswered,
    source: r.source,
    statusName: r.sname,
    state: r.state,
    subject: r.subject ?? "",
    dept: r.dept ?? "",
  }));
  return { items, total: Number(count[0]?.n ?? 0), page, pageSize };
}

/** Contatori aperti/chiusi (EndUser::getNumOpenTickets/getNumClosedTickets) e per help topic */
export async function clientTicketStats(cfg: ConfigNamespace, client: ClientIdentity, executor: DbOrTx = db()) {
  const extra = client.guest ? sql<SqlBool>` AND T.ticket_id = ${client.guest.ticketId}` : sql<SqlBool>``;
  const { rows } = await sql<{ state: string; topic_id: number; n: number; topic: string | null }>`
    SELECT S.state, T.topic_id, COUNT(*) AS n, HT.topic FROM ${table("ticket")} T
    JOIN ${table("ticket_status")} S ON (S.id = T.status_id)
    LEFT JOIN ${table("help_topic")} HT ON (HT.topic_id = T.topic_id)
    WHERE ${visibility(cfg, client)}${extra}
    GROUP BY S.state, T.topic_id, HT.topic`.execute(executor);
  let open = 0;
  let closed = 0;
  const topics = new Map<number, { id: number; name: string; count: number }>();
  for (const r of rows) {
    if (r.state === "open") open += Number(r.n);
    if (r.state === "closed") closed += Number(r.n);
    if (r.topic_id) {
      const t = topics.get(r.topic_id) ?? { id: r.topic_id, name: r.topic ?? "", count: 0 };
      t.count += Number(r.n);
      topics.set(r.topic_id, t);
    }
  }
  return { open, closed, topics: [...topics.values()].sort((a, b) => a.name.localeCompare(b.name)) };
}
