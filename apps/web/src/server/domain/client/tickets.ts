import "server-only";

import { sql, type SqlBool } from "kysely";

import type { ConfigNamespace } from "../../config/config";
import { db, table, type DbOrTx } from "../../db";
import { phpLooseEquals } from "../../php/values";
import { buildMatch } from "../queue/search";
import { upsertCdata } from "../forms/cdata";
import { cleanFromDb, fieldSearchKeys, fieldToDatabase, fieldToString, hasData, isEditableTo, isPresentationOnly, isRequiredFor, isStorable, isVisibleTo, parseField, validateField, type CleanValue, type FieldDef, type FieldErrorCode } from "../forms/fields";
import { loadFormDef } from "../forms/load";
import { logTicketEvent, type Actor } from "../ticket/events";
import { TicketRecord } from "../ticket/record";
import { ticketIsReopenable, loadStatus } from "../ticket/status";
import { loadThreadEntries, loadThreadEvents, type ThreadEntryView, type ThreadEventView } from "../ticket/ticket";
import { mergeTypeOf, TicketFlag } from "../ticket/merge-flags";
import type { ClientIdentity } from "./identity";

/**
 * Ticket del portale clienti: visibilità (EndUser/tickets.inc.php), accesso (Ticket::checkUserAccess),
 * vista (view.inc.php: thread senza note interne, campi visibili ai clienti) e modifica dei campi
 * da parte del proprietario (tickets.php a=edit).
 */

/** Ticket::checkUserAccess($thisclient) */
export async function clientCanAccess(client: ClientIdentity, ticketId: number, executor: DbOrTx = db()): Promise<boolean> {
  const t = await executor
    .selectFrom("ticket as t")
    .innerJoin("user as u", "u.id", "t.user_id")
    .leftJoin("thread as th", (j) => j.onRef("th.object_id", "=", "t.ticket_id").on("th.object_type", "=", "T"))
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
  if (t.flags & TicketFlag.PARENT && mergeTypeOf(t.flags) !== "visual") {
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

interface ClientAnswer {
  formTitle: string;
  label: string;
  value: string;
}

interface ClientTicketView {
  id: number;
  number: string;
  subject: string;
  statusName: string;
  state: string;
  dept: string;
  created: string;
  ownerName: string;
  ownerEmail: string;
  ownerPhone: string;
  isOwner: boolean;
  /** risposta consentita: aperto, oppure chiuso e riapribile; non per i figli di un merge */
  canReply: boolean;
  reopenOnReply: boolean;
  closedNotReopenable: boolean;
  /** figlio di un merge (risposte al padre) */
  parentId: number | null;
  canEdit: boolean;
  answers: ClientAnswer[];
  entries: ThreadEntryView[];
  events: ThreadEventView[];
  threadId: number;
}

/** Eventi mostrati ai clienti (include/client/templates/thread-entries.tmpl.php) */
const CLIENT_EVENTS = new Set(["created", "closed", "reopened", "edited", "collab", "merged"]);

/**
 * Vista del ticket per il cliente (view.inc.php): reparto pubblico o predefinito, campi visibili ai
 * clienti (esclusi oggetto, priorità e campi esterni), thread M/R (più le voci del cliente), eventi.
 */
export async function loadClientTicketView(cfg: ConfigNamespace, client: ClientIdentity, ticketId: number, executor: DbOrTx = db()): Promise<ClientTicketView | null> {
  if (!(await clientCanAccess(client, ticketId, executor))) return null;
  const t = await executor
    .selectFrom("ticket as t")
    .innerJoin("ticket_status as s", "s.id", "t.status_id")
    .leftJoin("department as d", "d.id", "t.dept_id")
    .leftJoin("ticket__cdata as cd", "cd.ticket_id", "t.ticket_id")
    .innerJoin("user as u", "u.id", "t.user_id")
    .leftJoin("user_email as ue", "ue.id", "u.default_email_id")
    .select(["t.ticket_id", "t.number", "t.created", "t.flags", "t.ticket_pid", "t.user_id", "s.name as sname", "s.state", "d.name as dname", "d.ispublic", "cd.subject", "u.name as uname", "ue.address"])
    .where("t.ticket_id", "=", ticketId)
    .executeTakeFirst();
  if (!t) return null;
  let dept = t.ispublic ? (t.dname ?? "") : "";
  if (!t.ispublic) {
    const d = await executor.selectFrom("department").select("name").where("id", "=", cfg.int("default_dept_id")).executeTakeFirst();
    dept = d?.name ?? "";
  }
  const thread = await executor.selectFrom("thread").select("id").where("object_type", "=", "T").where("object_id", "=", ticketId).executeTakeFirst();
  const threadId = thread?.id ?? 0;
  const rec = await TicketRecord.load(executor, ticketId);
  const status = await loadStatus(executor, rec!.get("status_id"));
  const closed = status?.state === "closed";
  const reopenable = closed && status ? await ticketIsReopenable(executor, rec!.row, status) : false;
  const isChild = !!t.ticket_pid && mergeTypeOf(t.flags) !== "visual";

  // Campi visibili ai clienti con un valore (DynamicFormEntry::forTicket)
  const entries = await executor.selectFrom("form_entry").select(["id", "form_id"]).where("object_type", "=", "T").where("object_id", "=", ticketId).orderBy("sort").orderBy("id").execute();
  const answers: ClientAnswer[] = [];
  let canEdit = false;
  let phone = "";
  for (const e of entries) {
    const def = await loadFormDef(executor, cfg, { id: e.form_id }, "client");
    if (!def) continue;
    const vals = await executor.selectFrom("form_entry_values").select(["field_id", "value", "value_id"]).where("entry_id", "=", e.id).execute();
    for (const f of def.fields) {
      if (isEditableTo(f, "client") && isStorable(f) && hasData(f) && !isPresentationOnly(f)) canEdit = true;
      const v = vals.find((x) => x.field_id === f.id);
      if (!v || !isStorable(f) || ["subject", "priority"].includes(f.name) || !(f.flags & 0x100)) continue;
      const text = fieldToString(f, cleanFromDb(f, v.value, v.value_id));
      if (text) answers.push({ formTitle: def.title, label: f.label, value: text });
    }
  }
  const phoneRow = await sql<{ value: string | null }>`SELECT V.value FROM ${table("form_entry")} FE JOIN ${table("form_entry_values")} V ON (V.entry_id = FE.id)
    JOIN ${table("form_field")} FF ON (FF.id = V.field_id) WHERE FE.object_type = 'U' AND FE.object_id = ${t.user_id} AND FF.name = 'phone' LIMIT 1`.execute(executor);
  phone = phoneRow.rows[0]?.value ?? "";

  const all = threadId ? await loadThreadEntries(threadId, executor) : [];
  const visible = all.filter((e) => e.type === "M" || e.type === "R" || (e.user_id && e.user_id === client.id));
  const events = threadId ? (await loadThreadEvents(threadId, executor)).filter((e) => CLIENT_EVENTS.has(e.name)) : [];
  return {
    id: t.ticket_id,
    number: t.number ?? "",
    subject: t.subject ?? "",
    statusName: t.sname,
    state: t.state ?? "",
    dept,
    created: t.created,
    ownerName: t.uname,
    ownerEmail: t.address ?? "",
    ownerPhone: phone,
    isOwner: t.user_id === client.id,
    canReply: (!closed || reopenable) && !isChild,
    reopenOnReply: closed && reopenable,
    closedNotReopenable: closed && !reopenable,
    parentId: isChild ? t.ticket_pid : null,
    canEdit: canEdit && t.user_id === client.id,
    answers,
    entries: visible,
    events,
    threadId,
  };
}

/** Allegato scaricabile dal cliente: voce del thread visibile (M/R o propria) di un ticket accessibile */
export async function clientAttachment(client: ClientIdentity, key: string, executor: DbOrTx = db()) {
  const ref = await executor
    .selectFrom("file as f")
    .innerJoin("attachment as a", "a.file_id", "f.id")
    .innerJoin("thread_entry as e", (j) => j.onRef("e.id", "=", "a.object_id").on("a.type", "=", "H"))
    .innerJoin("thread as th", "th.id", "e.thread_id")
    .select(["f.id as file_id", "a.name", "th.object_id", "th.object_type", "e.type", "e.user_id"])
    .where("f.key", "=", key)
    .execute();
  for (const r of ref) {
    if (r.object_type !== "T") continue;
    if (!(r.type === "M" || r.type === "R" || r.user_id === client.id)) continue;
    if (await clientCanAccess(client, r.object_id, executor)) return { fileId: r.file_id, name: r.name };
  }
  return null;
}

/** Form dei campi modificabili dal cliente (tickets.php a=edit) con i valori attuali */
export async function clientEditForms(cfg: ConfigNamespace, ticketId: number, executor: DbOrTx = db()) {
  const entries = await executor.selectFrom("form_entry").select(["id", "form_id"]).where("object_type", "=", "T").where("object_id", "=", ticketId).orderBy("sort").orderBy("id").execute();
  const out: { entryId: number; title: string; fields: FieldDef[]; values: Map<number, CleanValue> }[] = [];
  for (const e of entries) {
    const def = await loadFormDef(executor, cfg, { id: e.form_id }, "client");
    if (!def) continue;
    const vals = await executor.selectFrom("form_entry_values").select(["field_id", "value", "value_id"]).where("entry_id", "=", e.id).execute();
    const values = new Map<number, CleanValue>();
    for (const v of vals) {
      const f = def.fields.find((x) => x.id === v.field_id);
      if (f) values.set(f.id, cleanFromDb(f, v.value, v.value_id));
    }
    out.push({ entryId: e.id, title: def.title, fields: def.fields.filter((f) => isStorable(f)), values });
  }
  return out;
}

export type ClientEditResult = { ok: true; changes: number } | { error: "access" } | { error: "invalid"; fields: Record<number, FieldErrorCode[]> };

/**
 * tickets.php POST a=edit: solo il proprietario; validazione isValidForClient(true) dei campi
 * memorizzabili, risposte salvate per i campi visibili e modificabili dai clienti (cdata), evento
 * "edited" `{"fields":{"<id>":[vecchio,nuovo]}}` con l'utente come autore. Il ticket non viene
 * salvato (nessun updated, nessuna reindicizzazione di `_search`: come il PHP).
 */
export async function editTicketAsClient(tx: DbOrTx, cfg: ConfigNamespace, actor: Actor, client: ClientIdentity, ticketId: number, vars: Record<string, unknown>): Promise<ClientEditResult> {
  const rec = await TicketRecord.load(tx, ticketId, true);
  if (!rec || !(await clientCanAccess(client, ticketId, tx)) || rec.get("user_id") !== client.id) return { error: "access" };
  const forms = await clientEditForms(cfg, ticketId, tx);
  const tz = cfg.str("default_timezone") || "UTC";
  const errors: Record<number, FieldErrorCode[]> = {};
  const parsed = new Map<number, CleanValue>();
  for (const form of forms) {
    for (const f of form.fields) {
      if (!hasData(f) || isPresentationOnly(f)) continue;
      const clean = parseField(f, vars, tz);
      parsed.set(f.id, clean);
      if (!isEditableTo(f, "client")) continue;
      const codes = await validateField(f, clean, isRequiredFor(f, "client"), cfg);
      if (codes.length) errors[f.id] = codes;
    }
  }
  if (Object.keys(errors).length) return { error: "invalid", fields: errors };

  // DynamicFormEntry::getChanges su tutti i campi memorizzabili, anche quelli non visibili o non
  // modificabili dal cliente (assenti dal POST → nuovo valore nullo): stranezza del PHP replicata
  // nell'evento, ma si salvano solo i campi visibili e modificabili dai clienti.
  const changes: Record<string, [unknown, unknown]> = {};
  for (const form of forms) {
    const rows = await tx.selectFrom("form_entry_values").select(["field_id", "value", "value_id"]).where("entry_id", "=", form.entryId).execute();
    for (const f of form.fields) {
      if (!hasData(f) || isPresentationOnly(f)) continue;
      const cur = rows.find((r) => r.field_id === f.id);
      if (!cur) continue;
      const n = fieldToDatabase(f, parsed.get(f.id) ?? null);
      const idType = f.type === "priority" || f.type === "department";
      const same = phpLooseEquals(cur.value, n.value) && (!idType || phpLooseEquals(cur.value_id, n.valueId));
      if (same) continue;
      // [vecchio, nuovo] nel formato to_database
      if (!(String(f.id) in changes)) {
        const repr = (v: string | null, id: number | null) => (idType ? (v === null && id === null ? null : [v, id]) : v);
        changes[String(f.id)] = [repr(cur.value, cur.value_id), repr(n.value, n.valueId)];
      }
      if (!(isVisibleTo(f, "client") && isEditableTo(f, "client"))) continue;
      const set: Record<string, unknown> = { value: n.value };
      if (idType) set.value_id = n.valueId;
      await tx.updateTable("form_entry_values").set(set as never).where("entry_id", "=", form.entryId).where("field_id", "=", f.id).execute();
      await upsertCdata(tx, "T", ticketId, f, fieldSearchKeys(f, parsed.get(f.id) ?? null));
    }
  }
  const n = Object.keys(changes).length;
  if (n) {
    const th = await tx.selectFrom("thread").select("id").where("object_type", "=", "T").where("object_id", "=", ticketId).executeTakeFirstOrThrow();
    // $ticket->logEvent('edited', ['fields' => $changes], User::lookup($thisclient->getId()))
    const who: Actor = actor?.kind === "user" ? { ...actor } : actor;
    await logTicketEvent(tx, rec.row, th.id, actor, "edited", { fields: changes }, who ?? undefined);
  }
  return { ok: true, changes: n };
}
