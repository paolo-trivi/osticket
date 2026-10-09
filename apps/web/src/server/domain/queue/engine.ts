import "server-only";

import { sql, type RawBuilder } from "kysely";

import { coreConfig } from "../../config/config";
import { db, table, type DbOrTx } from "../../db";
import { phpJsonDecode } from "../../format/php-json";
import type { Agent } from "../staff/staff";
import { baseFields, cdataField, criterionSql, resolveTables, type Criterion, type FieldDef, type JoinKey } from "./fields";
import { keywordRelevanceSql, keywordTicketIds } from "./search";

/**
 * Code dei ticket (CustomQueue/SavedQueue di include/class.queue.php e class.search.php):
 * ereditarietà di criteri/colonne/ordinamenti, visibilità dell'agente, lista paginata e contatori.
 */
export const QueueFlag = {
  PUBLIC: 0x0001,
  QUEUE: 0x0002,
  DISABLED: 0x0004,
  INHERIT_CRITERIA: 0x0008,
  INHERIT_COLUMNS: 0x0010,
  INHERIT_SORTING: 0x0020,
  INHERIT_DEF_SORT: 0x0040,
} as const;

export interface QueueRow {
  id: number;
  parent_id: number;
  columns_id: number | null;
  sort_id: number | null;
  flags: number;
  staff_id: number;
  sort: number;
  title: string;
  config: string | null;
  filter: string | null;
}

export interface QueueColumnDef {
  id: number;
  heading: string;
  width: number;
  primary: string;
  secondary: string | null;
  filter: string | null;
  truncate: string | null;
  annotations: { c: string; p: string }[];
  conditions: { crit: Criterion; prop: Record<string, string> }[];
  sortable: boolean;
}

export interface QueueSortDef {
  id: number;
  name: string;
  columns: { path: string; desc: boolean }[];
}

export class TicketQueue {
  constructor(
    readonly row: QueueRow,
    readonly parent: TicketQueue | null,
    private readonly all: Map<number, TicketQueue>,
  ) {}

  get id() {
    return this.row.id;
  }
  get title() {
    return this.row.title;
  }
  has(flag: number) {
    return (this.row.flags & flag) !== 0;
  }
  get isAQueue() {
    return this.has(QueueFlag.QUEUE);
  }
  get isASubQueue(): boolean {
    return this.parent ? this.parent.isASubQueue : this.isAQueue;
  }
  get children(): TicketQueue[] {
    return [...this.all.values()].filter((q) => q.row.parent_id === this.id).sort((a, b) => a.row.sort - b.row.sort);
  }

  /** CustomQueue::getCriteria (formato vecchio [..] o nuovo {criteria:[..]}) */
  ownCriteria(): Criterion[] {
    const parsed = phpJsonDecode<unknown>(this.row.config, []);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return ((parsed as { criteria?: Criterion[] }).criteria ?? []) as Criterion[];
    }
    return Array.isArray(parsed) ? (parsed as Criterion[]) : [];
  }

  /** Criteri effettivi come getBasicQuery(): quelli del padre se la coda li eredita, poi i propri. */
  effectiveCriteria(): Criterion[] {
    const inherited =
      this.parent && this.has(QueueFlag.INHERIT_CRITERIA) && this.row.parent_id ? this.parent.effectiveCriteria() : [];
    return [...inherited, ...this.ownCriteria()];
  }

  /** Coda da cui prendere le colonne (columns_id, ereditarietà, oppure la coda stessa). */
  columnsSource(): TicketQueue {
    if (this.row.columns_id && this.all.get(this.row.columns_id)) return this.all.get(this.row.columns_id)!.columnsSource();
    if (this.row.parent_id && this.has(QueueFlag.INHERIT_COLUMNS) && this.parent) return this.parent.columnsSource();
    return this;
  }

  sortSource(): TicketQueue {
    return this.has(QueueFlag.INHERIT_SORTING) && this.parent ? this.parent.sortSource() : this;
  }

  defaultSortId(): number | null {
    if (this.has(QueueFlag.INHERIT_DEF_SORT) && this.parent) {
      const id = this.parent.defaultSortId();
      if (id) return id;
    }
    return this.row.sort_id;
  }
}

export async function loadQueues(executor: DbOrTx = db()): Promise<Map<number, TicketQueue>> {
  const rows = await executor
    .selectFrom("queue")
    .select(["id", "parent_id", "columns_id", "sort_id", "flags", "staff_id", "sort", "title", "config", "filter"])
    .where((eb) => eb.or([eb("root", "=", "T"), eb("root", "is", null)]))
    .orderBy("sort")
    .execute();
  const all = new Map<number, TicketQueue>();
  const byId = new Map(rows.map((r) => [r.id, { ...r, title: r.title ?? "" } as QueueRow]));
  const build = (id: number): TicketQueue | null => {
    if (all.has(id)) return all.get(id)!;
    const row = byId.get(id);
    if (!row) return null;
    const parent = row.parent_id ? build(row.parent_id) : null;
    const q = new TicketQueue(row, parent, all);
    all.set(id, q);
    return q;
  };
  for (const r of rows) build(r.id);
  return all;
}

/** Ricerca temporanea (AdhocSearch): non è una coda, appartiene all'agente. */
export function adhocQueue(agent: Agent, criteria: Criterion[], title: string): TicketQueue {
  const row: QueueRow = {
    id: 0,
    parent_id: 0,
    columns_id: null,
    sort_id: null,
    flags: 0,
    staff_id: agent.id,
    sort: 0,
    title,
    config: JSON.stringify({ criteria, conditions: [] }),
    filter: null,
  };
  return new TicketQueue(row, null, new Map());
}

/**
 * Ricerca rapida di scp/tickets.php (a=search): email → user__emails__address, numero → number,
 * altrimenti full-text. Massimo 3 parole.
 */
export function quickSearchCriteria(query: string): Criterion[] | null {
  const q = query.trim();
  if (!q || q.split(/\s+/u).length >= 4) return null;
  if (/(.*@.{2,})|(.{2,}@.*)/.test(q)) {
    const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q);
    return [["user__emails__address", valid ? "equal" : "contains", q]];
  }
  if (/^\d+(\.\d+)?$/.test(q)) return [["number", "contains", q]];
  return [[":keywords", null, q]];
}

/** Code visibili nella navigazione dell'agente: di sistema o personali, non disattivate. */
export function navigableQueues(all: Map<number, TicketQueue>, agent: Agent): TicketQueue[] {
  return [...all.values()].filter(
    (q) => !q.has(QueueFlag.DISABLED) && (q.row.staff_id === 0 || q.row.staff_id === agent.id) && (q.isAQueue || q.row.staff_id === agent.id),
  );
}

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
    .where("f.type", "=", "T")
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

function joinsFor(keys: Iterable<JoinKey>): RawBuilder<unknown> {
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
    referralExists("T", "S", [agent.id]),
    referralExists("C", "S", [agent.id]),
  ];
  const teams = agent.teamIds.filter(Boolean);
  if (teams.length) {
    assigned.push(sql`T.team_id IN (${sql.join(teams)})`, referralExists("T", "E", teams), referralExists("C", "E", teams));
  }
  const visibility: RawBuilder<unknown>[] = [
    sql`(ST.state IN ('open', 'closed') AND (${sql.join(assigned, sql` OR `)}))`,
  ];
  if (!agent.isAccessLimited && agent.deptIds.length) {
    const depts = [...agent.deptIds];
    let inDept = sql`(T.dept_id IN (${sql.join(depts)}) OR ${referralExists("T", "D", depts)})`;
    if (excludeArchived) inDept = sql`(ST.state IN ('open', 'closed') AND ${inDept})`;
    visibility.push(inDept, referralExists("C", "D", depts));
  }
  return sql`(${sql.join(visibility, sql` OR `)})`;
}

export interface CriteriaSql {
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

// --- Lista ---------------------------------------------------------------------

export interface ListOptions {
  /** ?sort=<id colonna> oppure "qs-<id ordinamento>" */
  sort?: string;
  dir?: 0 | 1;
  page?: number;
  pageSize: number;
  /** ricerca rapida aggiuntiva (barra di ricerca) */
  extraCriteria?: Criterion[];
}

export interface ListResult {
  ids: number[];
  total: number | null;
  page: number;
  pageSize: number;
}

async function loadColumnDefs(queue: TicketQueue, executor: DbOrTx): Promise<QueueColumnDef[]> {
  const src = queue.columnsSource();
  let rows = await executor
    .selectFrom("queue_columns as qc")
    .innerJoin("queue_column as c", "c.id", "qc.column_id")
    .select(["c.id", "qc.heading", "qc.width", "qc.sort", "qc.bits", "c.primary", "c.secondary", "c.filter", "c.truncate", "c.annotations", "c.conditions", "c.name"])
    .where("qc.queue_id", "=", src.id)
    .where("qc.staff_id", "=", src.row.staff_id)
    .orderBy("qc.sort")
    .execute();
  if (!rows.length && src.id !== 1) {
    // CustomQueue::getColumns(): in mancanza di colonne si usa la coda "Open" come modello
    rows = await executor
      .selectFrom("queue_columns as qc")
      .innerJoin("queue_column as c", "c.id", "qc.column_id")
      .select(["c.id", "qc.heading", "qc.width", "qc.sort", "qc.bits", "c.primary", "c.secondary", "c.filter", "c.truncate", "c.annotations", "c.conditions", "c.name"])
      .where("qc.queue_id", "=", 1)
      .where("qc.staff_id", "=", 0)
      .orderBy("qc.sort")
      .execute();
  }
  return rows.map((r) => ({
    id: r.id,
    heading: r.heading ?? r.name,
    width: r.width,
    primary: r.primary,
    secondary: r.secondary,
    filter: r.filter,
    truncate: r.truncate,
    annotations: phpJsonDecode(r.annotations, []),
    conditions: phpJsonDecode(r.conditions, []),
    sortable: (r.bits & 0x0001) !== 0,
  }));
}

export async function queueColumns(queue: TicketQueue, executor: DbOrTx = db()): Promise<QueueColumnDef[]> {
  return loadColumnDefs(queue, executor);
}

export async function queueSorts(queue: TicketQueue, executor: DbOrTx = db()): Promise<QueueSortDef[]> {
  const src = queue.sortSource();
  const rows = await executor
    .selectFrom("queue_sorts as qs")
    .innerJoin("queue_sort as s", "s.id", "qs.sort_id")
    .select(["s.id", "s.name", "s.columns"])
    .where("qs.queue_id", "=", src.id)
    .orderBy("qs.sort")
    .execute();
  return rows.map((r) => ({ id: r.id, name: r.name, columns: parseSortColumns(r.columns) }));
}

function parseSortColumns(json: string | null): { path: string; desc: boolean }[] {
  return phpJsonDecode<string[]>(json, []).map((p) => (p.startsWith("-") ? { path: p.slice(1), desc: true } : { path: p, desc: false }));
}

async function loadSort(id: number, executor: DbOrTx): Promise<QueueSortDef | null> {
  const r = await executor.selectFrom("queue_sort").select(["id", "name", "columns"]).where("id", "=", id).executeTakeFirst();
  return r ? { id: r.id, name: r.name, columns: parseSortColumns(r.columns) } : null;
}

export interface OrderKey {
  expr: RawBuilder<unknown>;
  desc: boolean;
}

function orderFor(field: FieldDef | undefined, desc: boolean, joins: Set<JoinKey>): OrderKey[] {
  if (!field) return [];
  const sortDef = field.sort;
  const cols = sortDef?.cols ?? [field.col];
  sortDef?.joins?.forEach((j) => joins.add(j));
  field.joins.forEach((j) => joins.add(j));
  const d = sortDef?.invert ? !desc : desc;
  return cols.map((c) => ({ expr: sql.raw(resolveTables(c)), desc: d }));
}

/** Ordinamento come queue-tickets.tmpl.php: colonna cliccata, poi ordinamento della coda, poi -created. */
export async function queueOrder(
  queue: TicketQueue,
  opts: Pick<ListOptions, "sort" | "dir">,
  fields: FieldRegistry,
  joins: Set<JoinKey>,
  executor: DbOrTx = db(),
): Promise<OrderKey[]> {
  const dir = opts.dir === 1;
  if (opts.sort && /^\d+$/.test(opts.sort)) {
    const col = (await loadColumnDefs(queue, executor)).find((c) => c.id === Number(opts.sort));
    if (col) {
      const primary = fields.get(col.primary);
      const secondary = col.secondary ? fields.get(col.secondary) : undefined;
      if (primary && secondary) {
        // QueueColumn::applySort con due chiavi: COALESCE(primaria, secondaria, 'zzz')
        primary.joins.forEach((j) => joins.add(j));
        secondary.joins.forEach((j) => joins.add(j));
        return [
          {
            expr: sql`COALESCE(${sql.raw(resolveTables(primary.col))}, ${sql.raw(resolveTables(secondary.col))}, 'zzz')`,
            desc: dir,
          },
        ];
      }
      if (primary) return orderFor(primary, dir, joins);
    }
  }
  let sortDef: QueueSortDef | null = null;
  if (opts.sort?.startsWith("qs-")) sortDef = await loadSort(Number(opts.sort.slice(3)), executor);
  if (!sortDef) {
    const def = queue.defaultSortId();
    if (def) sortDef = await loadSort(def, executor);
  }
  if (sortDef) {
    const out: OrderKey[] = [];
    for (const c of sortDef.columns) out.push(...orderFor(fields.get(c.path), dir ? !c.desc : c.desc, joins));
    if (out.length) return out;
  }
  return [{ expr: sql`T.created`, desc: true }];
}

export const orderSql = (keys: OrderKey[]) => keys.map((k) => sql`${k.expr} ${sql.raw(k.desc ? "DESC" : "ASC")}`);

/** Valori delle chiavi di ordinamento per un insieme di ticket (serve ai test sui pari merito). */
export async function orderKeyValues(
  queue: TicketQueue,
  opts: Pick<ListOptions, "sort" | "dir">,
  ids: number[],
  executor: DbOrTx = db(),
): Promise<Map<number, string>> {
  if (!ids.length) return new Map();
  const fields = await loadFieldRegistry(executor);
  const joins = new Set<JoinKey>(["ST"]);
  const keys = await queueOrder(queue, opts, fields, joins, executor);
  const { rows } = await sql<{ ticket_id: number; k: string }>`
    SELECT T.ticket_id, CONCAT_WS('|', ${sql.join(keys.map((k) => sql`COALESCE(${k.expr}, '∅')`))}) AS k
    FROM ${table("ticket")} T ${joinsFor(joins)} WHERE T.ticket_id IN (${sql.join(ids)})`.execute(executor);
  return new Map(rows.map((r) => [Number(r.ticket_id), String(r.k)]));
}

export async function listQueueTickets(
  agent: Agent,
  queue: TicketQueue,
  opts: ListOptions,
  ctx: { userTz: string },
  executor: DbOrTx = db(),
): Promise<ListResult> {
  const fields = await loadFieldRegistry(executor);
  const crit = compileCriteria([...queue.effectiveCriteria(), ...(opts.extraCriteria ?? [])], fields, { agent, userTz: ctx.userTz });
  const joins = new Set<JoinKey>(["ST", ...crit.joins]);
  // AdhocSearch/ricerche personali: chi ha "search.all" vede tutti i ticket (ignoreVisibilityConstraints)
  const ignoreVisibility =
    !queue.isAQueue && !queue.isASubQueue && queue.row.staff_id === agent.id && agent.hasGlobalPerm("search.all");
  const conds: RawBuilder<unknown>[] = [...crit.conditions];
  if (!ignoreVisibility) conds.push(visibilitySql(agent, false));
  if (queue.isAQueue || queue.isASubQueue) {
    // le code non mostrano i ticket figli di un merge (salvo collegati)
    conds.push(sql`(T.ticket_pid IS NULL OR (T.flags & 8) != 0)`);
  }

  // Full-text come tabella derivata (keywordRelevanceSql): visibilità e paginazione su tutti i risultati
  const keywords = crit.keywords !== null ? keywordRelevanceSql(crit.keywords) : null;
  const kwJoin = keywords ? sql`JOIN ${keywords} KW ON (KW.ticket_id = T.ticket_id)` : sql``;

  const keys = keywords ? [] : await queueOrder(queue, opts, fields, joins, executor);
  // Ordinamento stabile: T.ticket_id come ultima chiave (nella direzione della prima). Il PHP ordina solo per
  // le chiavi della coda, quindi a pari merito un ticket poteva ripetersi o mancare tra una pagina e l'altra.
  const order = keywords
    ? [sql`MAX(KW.relevance) DESC`, sql`T.ticket_id DESC`]
    : [...orderSql(keys), sql`T.ticket_id ${sql.raw(keys[0]?.desc ? "DESC" : "ASC")}`];
  const page = Math.max(1, opts.page ?? 1);
  const offset = (page - 1) * opts.pageSize;
  const where = sql.join(conds, sql` AND `);

  const { rows } = await sql<{ ticket_id: number }>`
    SELECT T.ticket_id FROM ${table("ticket")} T ${joinsFor(joins)} ${kwJoin}
    WHERE ${where}
    GROUP BY T.ticket_id
    ORDER BY ${sql.join(order)}
    LIMIT ${opts.pageSize} OFFSET ${offset}`.execute(executor);

  // Totale della paginazione contato con le stesse condizioni della lista. Il PHP usa il contatore della coda
  // (SavedQueue::counts: senza archiviati e con un altro filtro sui figli dei merge), quindi pagine mancanti o
  // vuote. I contatori della navigazione restano quelli del PHP (queueCounts).
  const { rows: countRows } = await sql<{ n: number }>`
    SELECT COUNT(DISTINCT T.ticket_id) AS n FROM ${table("ticket")} T ${joinsFor(joins)} ${kwJoin}
    WHERE ${where}`.execute(executor);
  const total = Number(countRows[0]?.n ?? 0);
  return { ids: rows.map((r) => Number(r.ticket_id)), total, page, pageSize: opts.pageSize };
}

export async function queueCounts(
  agent: Agent,
  queues: TicketQueue[],
  ctx: { userTz: string },
  executor: DbOrTx = db(),
  registry?: FieldRegistry,
): Promise<Map<number, number | "-">> {
  const fields = registry ?? (await loadFieldRegistry(executor));
  const result = new Map<number, number | "-">();
  const joins = new Set<JoinKey>(["ST", "TH"]);
  const selects: RawBuilder<unknown>[] = [];
  for (const q of queues) {
    const crit = compileCriteria(q.effectiveCriteria(), fields, { agent, userTz: ctx.userTz });
    if (crit.keywords !== null || !crit.conditions.length) {
      result.set(q.id, "-");
      continue;
    }
    crit.joins.forEach((j) => joins.add(j));
    const conds = [...crit.conditions];
    if (q.isAQueue || q.isASubQueue) conds.push(sql`TH.object_type = 'T'`);
    selects.push(sql`COUNT(DISTINCT CASE WHEN ${sql.join(conds, sql` AND `)} THEN T.ticket_id END) AS ${sql.ref(`q${q.id}`)}`);
  }
  if (!selects.length) return result;
  const { rows } = await sql<Record<string, number>>`
    SELECT ${sql.join(selects)} FROM ${table("ticket")} T ${joinsFor(joins)}
    WHERE ${visibilitySql(agent, true)}`.execute(executor);
  for (const [k, v] of Object.entries(rows[0] ?? {})) result.set(Number(k.slice(1)), Number(v));
  return result;
}

/**
 * Id dei ticket di una coda per l'export CSV (CustomQueue::export, area "ticketedit"): stessi criteri,
 * visibilità e ordinamento della lista, ma senza paginazione e senza il filtro sui figli dei merge
 * (l'export del PHP non lo applica).
 */
export async function exportQueueTicketIds(
  agent: Agent,
  queue: TicketQueue,
  opts: Pick<ListOptions, "sort" | "dir">,
  ctx: { userTz: string },
  executor: DbOrTx = db(),
): Promise<number[]> {
  const fields = await loadFieldRegistry(executor);
  const crit = compileCriteria(queue.effectiveCriteria(), fields, { agent, userTz: ctx.userTz });
  const joins = new Set<JoinKey>(["ST", ...crit.joins]);
  const ignoreVisibility =
    !queue.isAQueue && !queue.isASubQueue && queue.row.staff_id === agent.id && agent.hasGlobalPerm("search.all");
  const conds: RawBuilder<unknown>[] = [...crit.conditions];
  if (!ignoreVisibility) conds.push(visibilitySql(agent, false));
  if (crit.keywords !== null) {
    const ids = await keywordTicketIds(crit.keywords, executor);
    if (ids !== null) conds.push(ids.length ? sql`T.ticket_id IN (${sql.join(ids)})` : sql`(0)`);
  }
  const order = orderSql(await queueOrder(queue, opts, fields, joins, executor));
  const { rows } = await sql<{ ticket_id: number }>`
    SELECT T.ticket_id FROM ${table("ticket")} T ${joinsFor(joins)}
    ${conds.length ? sql`WHERE ${sql.join(conds, sql` AND `)}` : sql``}
    GROUP BY T.ticket_id
    ORDER BY ${sql.join(order)}`.execute(executor);
  return rows.map((r) => Number(r.ticket_id));
}
