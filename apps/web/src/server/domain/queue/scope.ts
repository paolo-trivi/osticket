import "server-only";

import { sql, type RawBuilder } from "kysely";

import { FormType, ObjectType } from "@/lib/osticket/object-types";
import { Ticket } from "@/lib/osticket/flags";

import { coreConfig } from "../../config/config";
import { db, table, type DbOrTx } from "../../db";
import type { Agent } from "../staff/staff";
import { baseFields, cdataField, criterionSql, type Criterion, type FieldDef, type JoinKey } from "./fields";
import type { TicketQueue } from "./queues";
import { keywordRelevanceSql } from "./search";

/**
 * Costruzione SQL dell'insieme dei ticket di una coda (CustomQueue::getBasicQuery, include/class.queue.php):
 * campi interrogabili, JOIN, visibilità dell'agente (Staff::getTicketsVisibility), criteri compilati,
 * filtro sui figli dei merge e ricerca full-text.
 */

// --- Campi -------------------------------------------------------------------

export interface FieldRegistry {
  get(path: string): FieldDef | undefined;
}

export async function loadFieldRegistry(executor: DbOrTx = db()): Promise<FieldRegistry> {
  const cfg = await coreConfig();
  const fields: Record<string, FieldDef> = baseFields(cfg.str("agent_name_format", "full"));
  // Campi del form ticket (form.type = 'T') con dati memorizzabili → ticket__cdata
  const ticketFields = await executor
    .selectFrom("form_field as ff")
    .innerJoin("form as f", "f.id", "ff.form_id")
    .select(["ff.id", "ff.name", "ff.type"])
    .where("f.type", "=", FormType.TICKET)
    .where("ff.type", "not in", ["thread", "break", "info"])
    .execute();
  for (const f of ticketFields) {
    const name = f.name || `field_${f.id}`;
    fields[`cdata__${name}`] = cdataField(name, f.type);
  }
  return { get: (path) => fields[path] };
}

// --- SQL di base ---------------------------------------------------------------

const JOIN_ORDER: JoinKey[] = ["ST", "CD", "PR", "TH", "U", "UE", "ORG", "D", "S", "TM", "HT", "SL"];

function joinSql(key: JoinKey): RawBuilder<unknown> {
  switch (key) {
    case "ST":
      return sql`INNER JOIN ${table("ticket_status")} ST ON (ST.id = T.status_id)`;
    case "CD":
      return sql`LEFT JOIN ${table("ticket__cdata")} CD ON (CD.ticket_id = T.ticket_id)`;
    case "PR":
      return sql`LEFT JOIN ${table("ticket_priority")} PR ON (PR.priority_id = CD.priority)`;
    case "TH":
      return sql`LEFT JOIN ${table("thread")} TH ON (TH.object_id = T.ticket_id AND TH.object_type = 'T')`;
    case "U":
      return sql`LEFT JOIN ${table("user")} U ON (U.id = T.user_id)`;
    case "UE":
      return sql`LEFT JOIN ${table("user_email")} UE ON (UE.user_id = T.user_id)`;
    case "ORG":
      return sql`LEFT JOIN ${table("organization")} ORG ON (ORG.id = U.org_id)`;
    case "D":
      return sql`LEFT JOIN ${table("department")} D ON (D.id = T.dept_id)`;
    case "S":
      return sql`LEFT JOIN ${table("staff")} S ON (S.staff_id = T.staff_id)`;
    case "TM":
      return sql`LEFT JOIN ${table("team")} TM ON (TM.team_id = T.team_id)`;
    case "HT":
      return sql`LEFT JOIN ${table("help_topic")} HT ON (HT.topic_id = T.topic_id)`;
    case "SL":
      return sql`LEFT JOIN ${table("sla")} SL ON (SL.id = T.sla_id)`;
  }
}

export function joinsFor(keys: Iterable<JoinKey>): RawBuilder<unknown> {
  const set = new Set(keys);
  if (set.has("PR")) set.add("CD");
  if (set.has("ORG")) set.add("U");
  return sql.join(
    JOIN_ORDER.filter((k) => set.has(k)).map(joinSql),
    sql` `,
  );
}

/** Esistenza di un referral del thread (T o figlio di merge C) verso agente/team/reparto. */
function referralExists(objectType: "T" | "C", refType: "S" | "E" | "D", ids: number[]): RawBuilder<unknown> {
  return sql`EXISTS (SELECT 1 FROM ${table("thread")} RT JOIN ${table("thread_referral")} RR ON (RR.thread_id = RT.id)
    WHERE RT.object_id = T.ticket_id AND RT.object_type = ${objectType}
    AND RR.object_type = ${refType} AND RR.object_id IN (${sql.join(ids)}))`;
}

/** Staff::getTicketsVisibility() — richiede il join ST. */
export function visibilitySql(agent: Agent, excludeArchived: boolean): RawBuilder<unknown> {
  const assigned: RawBuilder<unknown>[] = [
    sql`T.staff_id = ${agent.id}`,
    referralExists(ObjectType.TICKET, ObjectType.STAFF, [agent.id]),
    referralExists(ObjectType.CHILD_TICKET, ObjectType.STAFF, [agent.id]),
  ];
  const teams = agent.teamIds.filter(Boolean);
  if (teams.length) {
    assigned.push(sql`T.team_id IN (${sql.join(teams)})`, referralExists(ObjectType.TICKET, ObjectType.TEAM, teams), referralExists(ObjectType.CHILD_TICKET, ObjectType.TEAM, teams));
  }
  const visibility: RawBuilder<unknown>[] = [
    sql`(ST.state IN ('open', 'closed') AND (${sql.join(assigned, sql` OR `)}))`,
  ];
  if (!agent.isAccessLimited && agent.deptIds.length) {
    const depts = [...agent.deptIds];
    let inDept = sql`(T.dept_id IN (${sql.join(depts)}) OR ${referralExists(ObjectType.TICKET, ObjectType.DEPT, depts)})`;
    if (excludeArchived) inDept = sql`(ST.state IN ('open', 'closed') AND ${inDept})`;
    visibility.push(inDept, referralExists(ObjectType.CHILD_TICKET, ObjectType.DEPT, depts));
  }
  return sql`(${sql.join(visibility, sql` OR `)})`;
}

interface CriteriaSql {
  conditions: RawBuilder<unknown>[];
  joins: Set<JoinKey>;
  /** criterio :keywords presente (ricerca full-text) */
  keywords: string | null;
}

export function compileCriteria(
  criteria: Criterion[],
  fields: FieldRegistry,
  ctx: { agent: Agent; userTz: string },
): CriteriaSql {
  const out: CriteriaSql = { conditions: [], joins: new Set(), keywords: null };
  for (const [path, method, value] of criteria) {
    if (path === ":keywords") {
      out.keywords = String(value ?? "");
      continue;
    }
    const field = fields.get(path);
    if (!field || !method) continue; // come in PHP: campo non supportato → criterio ignorato
    const cond = criterionSql(field, method, value, ctx);
    if (!cond) continue;
    out.conditions.push(cond);
    field.joins.forEach((j) => out.joins.add(j));
  }
  return out;
}

/** Le code non mostrano i ticket figli di un merge, salvo i collegati (Ticket::FLAG_LINKED). Alias T. */
export function mergeChildFilterSql(): RawBuilder<unknown> {
  return sql`(T.ticket_pid IS NULL OR (T.flags & ${sql.lit(Ticket.LINKED)}) != 0)`;
}

/**
 * Insieme dei ticket di una coda o ricerca, senza ordinamento né paginazione (alias della lista: T, ST, …):
 * criteri compilati, visibilità dell'agente (salvo `search.all` per ricerche personali e temporanee), filtro
 * sui figli dei merge per le code e ricerca full-text come tabella derivata `KW` in JOIN.
 */
interface QueueScope {
  fields: FieldRegistry;
  conditions: RawBuilder<unknown>[];
  joins: Set<JoinKey>;
  /** testo del criterio :keywords (null = nessuna ricerca full-text) */
  keywords: string | null;
  /** JOIN della ricerca full-text (KW: ticket_id, relevance); null se assente o testo troppo corto (nessun filtro) */
  keywordJoin: RawBuilder<unknown> | null;
}

export async function queueScope(
  agent: Agent,
  queue: TicketQueue,
  ctx: { userTz: string },
  opts: { extraCriteria?: Criterion[]; mergeFilter?: boolean } = {},
  executor: DbOrTx = db(),
): Promise<QueueScope> {
  const fields = await loadFieldRegistry(executor);
  const crit = compileCriteria([...queue.effectiveCriteria(), ...(opts.extraCriteria ?? [])], fields, { agent, userTz: ctx.userTz });
  const joins = new Set<JoinKey>(["ST", ...crit.joins]);
  // AdhocSearch/ricerche personali: chi ha "search.all" vede tutti i ticket (ignoreVisibilityConstraints)
  const ignoreVisibility =
    !queue.isAQueue && !queue.isASubQueue && queue.row.staff_id === agent.id && agent.hasGlobalPerm("search.all");
  const conditions: RawBuilder<unknown>[] = [...crit.conditions];
  if (!ignoreVisibility) conditions.push(visibilitySql(agent, false));
  if ((opts.mergeFilter ?? true) && (queue.isAQueue || queue.isASubQueue)) conditions.push(mergeChildFilterSql());
  // Full-text come tabella derivata (keywordRelevanceSql): visibilità e paginazione su tutti i risultati
  const keywords = crit.keywords !== null ? keywordRelevanceSql(crit.keywords) : null;
  const keywordJoin = keywords ? sql`JOIN ${keywords} KW ON (KW.ticket_id = T.ticket_id)` : null;
  return { fields, conditions, joins, keywords: crit.keywords, keywordJoin };
}

/** `SELECT T.ticket_id …` dello scope, da usare come `T.ticket_id IN (…)` in altre query (es. la board). */
export function queueScopeIdsSql(scope: QueueScope): RawBuilder<unknown> {
  return sql`SELECT T.ticket_id FROM ${table("ticket")} T ${joinsFor(scope.joins)} ${scope.keywordJoin ?? sql``}
    WHERE ${scope.conditions.length ? sql.join(scope.conditions, sql` AND `) : sql`1`}`;
}
