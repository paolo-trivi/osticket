import "server-only";

import { DateTime } from "luxon";
import { sql, type RawBuilder } from "kysely";

import { dbTimezone, toDb } from "../../db/time";
import { installConfig } from "../../env";
import type { Agent } from "../staff/staff";
import { dateRange } from "./period";

/**
 * Campi ricercabili dei ticket (Ticket::getSearchableFields in include/class.ticket.php) tradotti in SQL.
 * Ogni metodo replica getSearchQ() del tipo di campo PHP corrispondente (class.forms.php, class.search.php).
 * Alias usati nella query: T ticket, ST stato, CD ticket__cdata, TH thread, U utente, ORG organizzazione,
 * D reparto, S agente, TM team, HT help topic, SL sla, PR priorità (via CD.priority).
 */
export type JoinKey = "ST" | "CD" | "TH" | "U" | "UE" | "ORG" | "D" | "S" | "TM" | "HT" | "SL" | "PR";

export type FieldKind =
  | "text" // FormField / TextboxField
  | "datetime" // DatetimeField
  | "bool" // BooleanField
  | "number" // NumericField / campi conteggio
  | "selection" // AdvancedSearchSelectionField (id numerici con 0 = vuoto)
  | "choice" // ChoiceField (REGEXP sui valori)
  | "status" // TicketStatusChoiceField
  | "assignee" // AssigneeChoiceField
  | "isassigned"
  | "merged"
  | "linked";

export interface FieldDef {
  kind: FieldKind;
  /** espressione SQL (costante, mai input utente) */
  col: string;
  joins: JoinKey[];
  /** chiavi di ordinamento (default: col); invert = PriorityField ordina per urgenza invertendo la direzione */
  sort?: { cols: string[]; joins?: JoinKey[]; invert?: boolean };
}

export type Criterion = [string, string | null, unknown];

interface CriteriaContext {
  agent: Agent;
  /** fuso dell'utente (OsticketConfig::getTimezone) per i periodi */
  userTz: string;
}

const TICKET_FLAG_COMBINE = 0x0001;
const TICKET_FLAG_SEPARATE = 0x0002;
const TICKET_FLAG_LINKED = 0x0008;

/** Ordinamento per nome agente secondo agent_name_format (Staff::getsortby). */
function staffSortCols(alias: string, nameFormat: string): string[] {
  return ["last", "lastfirst", "legal"].includes(nameFormat)
    ? [`${alias}.lastname`, `${alias}.firstname`]
    : [`${alias}.firstname`, `${alias}.lastname`];
}

export function baseFields(nameFormat: string): Record<string, FieldDef> {
  const dt = (col: string): FieldDef => ({ kind: "datetime", col, joins: [] });
  return {
    number: { kind: "text", col: "T.number", joins: [] },
    created: dt("T.created"),
    duedate: dt("T.duedate"),
    est_duedate: dt("T.est_duedate"),
    reopened: dt("T.reopened"),
    closed: dt("T.closed"),
    lastupdate: dt("T.lastupdate"),
    assignee: {
      kind: "assignee",
      col: "T.staff_id",
      joins: ["S", "TM"],
      sort: { cols: [...staffSortCols("S", nameFormat), "TM.name"], joins: ["S", "TM"] },
    },
    staff_id: { kind: "selection", col: "T.staff_id", joins: [], sort: { cols: staffSortCols("S", nameFormat), joins: ["S"] } },
    team_id: { kind: "selection", col: "T.team_id", joins: [], sort: { cols: ["TM.name"], joins: ["TM"] } },
    dept_id: { kind: "selection", col: "T.dept_id", joins: [], sort: { cols: ["D.name"], joins: ["D"] } },
    sla_id: { kind: "selection", col: "T.sla_id", joins: [], sort: { cols: ["SL.name"], joins: ["SL"] } },
    topic_id: { kind: "selection", col: "T.topic_id", joins: [], sort: { cols: ["HT.topic"], joins: ["HT"] } },
    source: { kind: "choice", col: "T.source", joins: [] },
    isoverdue: { kind: "bool", col: "T.isoverdue", joins: [] },
    isanswered: { kind: "bool", col: "T.isanswered", joins: [] },
    isassigned: { kind: "isassigned", col: "T.staff_id", joins: [] },
    merged: { kind: "merged", col: "T.flags", joins: [] },
    linked: { kind: "linked", col: "T.flags", joins: [] },
    ip_address: { kind: "text", col: "T.ip_address", joins: [] },
    "status__id": { kind: "status", col: "T.status_id", joins: [], sort: { cols: ["ST.name"], joins: ["ST"] } },
    "status__state": { kind: "selection", col: "ST.state", joins: ["ST"] },
    "status__name": { kind: "text", col: "ST.name", joins: ["ST"] },
    "thread__lastmessage": { kind: "datetime", col: "TH.lastmessage", joins: ["TH"] },
    "thread__lastresponse": { kind: "datetime", col: "TH.lastresponse", joins: ["TH"] },
    user_id: { kind: "text", col: "T.user_id", joins: [] },
    "user__name": { kind: "text", col: "U.name", joins: ["U"] },
    "user__org__name": { kind: "text", col: "ORG.name", joins: ["U", "ORG"] },
    "user__emails__address": { kind: "text", col: "UE.address", joins: ["UE"] },
    "user__org_id": { kind: "selection", col: "U.org_id", joins: ["U"] },
    "dept__name": { kind: "text", col: "D.name", joins: ["D"] },
    "topic__topic": { kind: "text", col: "HT.topic", joins: ["HT"] },
    // conteggi (AnnotatedField): sottoquery correlate
    thread_count: {
      kind: "number",
      col: "(SELECT COUNT(*) FROM {thread_entry} E WHERE E.thread_id = TH.id AND E.type IN ('M','R'))",
      joins: ["TH"],
    },
    attachment_count: {
      kind: "number",
      col: "(SELECT COUNT(*) FROM {thread_entry} E JOIN {attachment} A ON (A.object_id = E.id AND A.type = 'H' AND A.inline = 0) WHERE E.thread_id = TH.id)",
      joins: ["TH"],
    },
    collaborator_count: {
      kind: "number",
      col: "(SELECT COUNT(*) FROM {thread_collaborator} C WHERE C.thread_id = TH.id)",
      joins: ["TH"],
    },
    task_count: {
      kind: "number",
      col: "(SELECT COUNT(*) FROM {task} K WHERE K.object_id = T.ticket_id AND K.object_type = 'T')",
      joins: [],
    },
    reopen_count: {
      kind: "number",
      col: "(SELECT COUNT(*) FROM {thread_event} V JOIN {event} EV ON (EV.id = V.event_id) WHERE V.thread_id = TH.id AND EV.name = 'reopened')",
      joins: ["TH"],
    },
  };
}

/** Campi del form ticket materializzati in ticket__cdata (cdata__<nome>), dal tipo del form_field. */
export function cdataField(name: string, type: string): FieldDef {
  const col = `CD.\`${name.replace(/`/g, "")}\``;
  if (type === "priority") {
    return {
      kind: "choice",
      col,
      joins: ["CD"],
      // PriorityField::applyOrderBy: per urgenza della priorità, direzione invertita
      sort: { cols: ["PR.priority_urgency"], joins: ["CD", "PR"], invert: true },
    };
  }
  if (type === "bool") return { kind: "bool", col, joins: ["CD"] };
  if (type === "datetime") return { kind: "datetime", col, joins: ["CD"] };
  if (type === "number") return { kind: "number", col, joins: ["CD"] };
  if (type === "choices" || type.startsWith("list-")) return { kind: "choice", col, joins: ["CD"] };
  return { kind: "text", col, joins: ["CD"] };
}

const raw = (s: string) => sql.raw(s);

/** Sostituisce i segnaposto {tabella} con il nome reale (prefisso dell'installazione). */
export function resolveTables(expr: string): string {
  const prefix = installConfig().tablePrefix;
  return expr.replace(/\{([a-z_]+)\}/g, (_, t: string) => `\`${prefix}${t}\``);
}

/** ChoiceField: espressione regolare sulle chiavi selezionate (stesso pattern del PHP). */
function choiceRegex(value: unknown): string {
  const keys = value && typeof value === "object" ? Object.keys(value as object) : [String(value ?? "")];
  return '"?(?<![0-9])' + keys.join('("|,|$)|"?(?<![0-9])') + '("|,|$)';
}

function parseUserDate(value: unknown, tz: string): DateTime | null {
  if (typeof value !== "string" || value.length <= 2) return null;
  const dt = DateTime.fromISO(value.replace(" ", "T"), { zone: tz });
  return dt.isValid ? dt : null;
}

const INTERVALS: Record<string, string> = { m: "MONTH", w: "WEEK", d: "DAY", h: "HOUR", i: "MINUTE" };

function intervalOf(value: unknown): { unit: string; n: number } {
  const v = (value ?? {}) as { int?: string; until?: number | string };
  return { unit: INTERVALS[String(v.int ?? "d")] ?? "DAY", n: Number(v.until ?? 0) || 0 };
}

/** FormField::getSearchQ (metodi generici). */
function genericQ(col: RawBuilder<unknown>, method: string, value: unknown): RawBuilder<unknown> | null {
  switch (method) {
    case "set":
      return sql`(${col} IS NOT NULL)`;
    case "nset":
      return sql`(NOT (${col} IS NOT NULL))`;
    case "equal":
      return sql`(${col} = ${value as string})`;
    case "nequal":
      return sql`(NOT (${col} = ${value as string}))`;
    case "contains":
      return sql`(${col} LIKE ${"%" + String(value) + "%"})`;
    case "match":
      return sql`(${col} REGEXP ${String(value)})`;
    default:
      return null;
  }
}

function datetimeQ(col: RawBuilder<unknown>, method: string, value: unknown, ctx: CriteriaContext): RawBuilder<unknown> | null {
  const userDate = parseUserDate(value, ctx.userTz);
  switch (method) {
    case "equal":
    case "nequal": {
      if (!userDate) return null;
      const l = toDb(userDate);
      const r = toDb(userDate.plus({ days: 1 }));
      return method === "equal"
        ? sql`(${col} >= ${l} AND ${col} < ${r})`
        : sql`(${col} < ${l} OR ${col} >= ${r})`;
    }
    case "future":
      return sql`(${col} >= NOW())`;
    case "after":
      return userDate ? sql`(${col} >= ${toDb(userDate)})` : null;
    case "past":
      return sql`(${col} < NOW())`;
    case "before":
      return userDate ? sql`(${col} < ${toDb(userDate)})` : null;
    case "between": {
      const v = (value ?? {}) as { left?: string; right?: string };
      const left = parseUserDate(v.left, ctx.userTz);
      const right = parseUserDate(v.right, ctx.userTz);
      if (!left || !right) return null;
      return sql`(${col} >= ${toDb(left.startOf("day"))} AND ${col} <= ${toDb(right.set({ hour: 23, minute: 59, second: 59 }))})`;
    }
    case "ndaysago": {
      const { unit, n } = intervalOf(value);
      return sql`(${col} BETWEEN NOW() - INTERVAL ${n} ${raw(unit)} AND NOW())`;
    }
    case "ndays": {
      const { unit, n } = intervalOf(value);
      return sql`(${col} BETWEEN NOW() AND NOW() + INTERVAL ${n} ${raw(unit)})`;
    }
    case "distpast": {
      const { unit, n } = intervalOf(value);
      return sql`(${col} <= NOW() - INTERVAL ${n} ${raw(unit)})`;
    }
    case "distfut": {
      const { unit, n } = intervalOf(value);
      return sql`(${col} >= NOW() + INTERVAL ${n} ${raw(unit)})`;
    }
    case "period": {
      const range = dateRange(String(value), DateTime.now().setZone(ctx.userTz));
      if (!range) return null;
      const fmt = (d: DateTime) => d.setZone(dbTimezone()).toFormat("yyyy-MM-dd HH:mm:ss");
      return sql`(${col} BETWEEN ${fmt(range.start)} AND ${fmt(range.end)})`;
    }
    default:
      return genericQ(col, method, value);
  }
}

/** Traduce un criterio [campo, metodo, valore] in condizione SQL (null = criterio ignorato, come in PHP). */
export function criterionSql(
  field: FieldDef,
  method: string,
  value: unknown,
  ctx: CriteriaContext,
): RawBuilder<unknown> | null {
  const col = raw(resolveTables(field.col));
  const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value as object) : [];

  switch (field.kind) {
    // TextboxField / FormField::getSearchQ: set, nset, equal, nequal, contains, match
    case "text":
      return genericQ(col, method, value);

    case "bool":
      if (method === "set") return sql`(${col} = '1')`;
      if (method === "nset") return sql`(${col} = '0')`;
      return genericQ(col, method, value);

    case "number":
      if (method === "equal") return sql`(${col} = ${Number.parseInt(String(value), 10) || 0})`;
      if (method === "greater") return sql`(${col} > ${Number.parseInt(String(value), 10) || 0})`;
      if (method === "less") return sql`(${col} < ${Number.parseInt(String(value), 10) || 0})`;
      return genericQ(col, method, value);

    case "datetime":
      return datetimeQ(col, method, value, ctx);

    case "choice":
      if (method === "includes") return sql`(${col} REGEXP ${choiceRegex(value)})`;
      if (method === "!includes") return sql`(NOT (${col} REGEXP ${choiceRegex(value)}))`;
      return genericQ(col, method, value);

    case "selection": {
      if (method === "includes" || method === "!includes") {
        if (!keys.length) return null;
        const cond = keys.length > 1 ? sql`(${col} IN (${sql.join(keys)}))` : sql`(${col} = ${keys[0]})`;
        return method === "!includes" ? sql`(NOT ${cond})` : cond;
      }
      if (method === "nset") return sql`(${col} = 0)`;
      if (method === "set") return sql`(NOT (${col} = 0))`;
      return genericQ(col, method, value);
    }

    case "status":
      if (!keys.length) return null;
      if (method === "includes") return sql`(${col} IN (${sql.join(keys)}))`;
      if (method === "!includes") return sql`(NOT (${col} IN (${sql.join(keys)})))`;
      return genericQ(col, method, value);

    case "assignee": {
      if (method === "assigned") return sql`(NOT (T.team_id = 0 AND T.staff_id = 0))`;
      if (method === "!assigned") return sql`(T.team_id = 0 AND T.staff_id = 0)`;
      if (method !== "includes" && method !== "!includes") return null;
      let teams: number[] = [];
      const agents: number[] = [];
      for (const id of keys) {
        if (id[0] === "M") agents.push(ctx.agent.id);
        else if (id[0] === "s") agents.push(Number.parseInt(id.slice(1), 10));
        else if (id[0] === "T") {
          if (ctx.agent.teamIds.length) teams = [...ctx.agent.teamIds];
          else if (keys.length === 1) return sql`(T.team_id IS NULL)`;
        } else if (id[0] === "t") teams.push(Number.parseInt(id.slice(1), 10));
      }
      const parts: RawBuilder<unknown>[] = [];
      if (teams.length) parts.push(sql`T.team_id IN (${sql.join(teams)})`);
      if (agents.length) parts.push(sql`T.staff_id IN (${sql.join(agents)})`);
      const any = parts.length ? sql`(${sql.join(parts, sql` OR `)})` : sql`(1)`;
      return method === "!includes" ? sql`(NOT ${any})` : any;
    }

    case "isassigned":
      if (method === "assigned" || method === "set") return sql`(NOT (T.staff_id = 0 AND T.team_id = 0))`;
      if (method === "!assigned" || method === "nset") return sql`(T.staff_id = 0 AND T.team_id = 0)`;
      return null;

    case "merged":
      if (method === "set")
        return sql`((T.flags & ${TICKET_FLAG_SEPARATE}) != 0 OR (T.flags & ${TICKET_FLAG_COMBINE}) != 0)`;
      if (method === "nset")
        return sql`(NOT ((T.flags & ${TICKET_FLAG_SEPARATE}) != 0) AND NOT ((T.flags & ${TICKET_FLAG_COMBINE}) != 0))`;
      return null;

    case "linked":
      if (method === "set") return sql`((T.flags & ${TICKET_FLAG_LINKED}) != 0)`;
      if (method === "nset") return sql`(NOT ((T.flags & ${TICKET_FLAG_LINKED}) != 0))`;
      return null;
  }
  return null;
}
