import "server-only";

import { DateTime } from "luxon";
import { sql, type RawBuilder } from "kysely";

import { db, table, type DbOrTx } from "../../db";
import { toDb } from "../../db/time";
import { GlobalPerm, type Agent } from "../staff/staff";

/**
 * Statistiche della dashboard: port di OverviewReport (include/class.report.php).
 * Tutto si basa su thread_event (eventi non annullati) nel periodo scelto.
 */
export const PERIOD_CHOICES = ["now", "+7 days", "+14 days", "+1 month", "+3 months"] as const;
type PeriodEnd = (typeof PERIOD_CHOICES)[number];

export interface ReportRange {
  start: string;
  stop: string;
  /** primo giorno dell'intervallo (yyyy-mm-dd) nel fuso dell'agente */
  startDay: string;
  /** ultimo giorno incluso (yyyy-mm-dd) nel fuso dell'agente: se la fine cade a mezzanotte, il giorno prima */
  lastDay: string;
  /** fuso dell'agente in cui è calcolato l'intervallo */
  zone: string;
}

/** getDateRange(): inizio scelto dall'utente (default: un mese fa), fine "oggi" o inizio + intervallo. */
export function reportRange(startDate: string | undefined, end: PeriodEnd, userTz: string): ReportRange {
  const now = DateTime.now().setZone(userTz);
  const start = startDate ? DateTime.fromISO(startDate, { zone: userTz }).startOf("day") : now.minus({ months: 1 });
  const valid = start.isValid ? start : now.minus({ months: 1 });
  let stop = now;
  const m = /^\+(\d+) (days|month|months)$/.exec(end);
  if (m) stop = m[2] === "days" ? valid.plus({ days: Number(m[1]) }) : valid.plus({ months: Number(m[1]) });
  // Solo per le etichette (testo dell'intervallo, nome del file CSV): le query usano start/stop
  const atMidnight = +stop === +stop.startOf("day") && stop > valid;
  return {
    start: toDb(valid),
    stop: toDb(stop),
    startDay: valid.toISODate() ?? "",
    lastDay: (atMidnight ? stop.minus({ days: 1 }) : stop).toISODate() ?? "",
    zone: userTz,
  };
}

/** Normalizza i parametri della dashboard (?start=&period=&group=) come la pagina. */
export function parsePeriod(period: string | null | undefined): PeriodEnd {
  return (PERIOD_CHOICES as readonly string[]).includes(period ?? "") ? (period as PeriodEnd) : "now";
}

export const TABULAR_GROUPS = ["dept", "topic", "staff"] as const;
export type TabularGroup = (typeof TABULAR_GROUPS)[number];

export function parseGroup(group: string | null | undefined): TabularGroup {
  return group === "topic" || group === "staff" ? group : "dept";
}

async function eventIds(executor: DbOrTx): Promise<Record<string, number>> {
  const rows = await executor.selectFrom("event").select(["id", "name"]).execute();
  return Object.fromEntries(rows.map((r) => [r.name, r.id]));
}

interface PlotData {
  days: string[];
  series: { name: string; data: number[] }[];
}

/**
 * getPlotData(): eventi per giorno e per tipo.
 * Differenza voluta (permessi): il PHP conta gli eventi di tutti i reparti, anche quelli che l'agente
 * non vede; qui solo i reparti dell'agente, lo stesso perimetro delle tabelle (getTabularData).
 */
export async function plotData(range: ReportRange, agent: Agent, executor: DbOrTx = db()): Promise<PlotData> {
  const depts = agent.deptIds.length ? [...agent.deptIds] : [0];
  const { rows } = await sql<{ name: string; day: string; n: number }>`
    SELECT H.name, DATE_FORMAT(E.timestamp, '%Y-%m-%d') AS day, COUNT(DISTINCT E.id) AS n
    FROM ${table("thread_event")} E LEFT JOIN ${table("event")} H ON (E.event_id = H.id)
    WHERE E.timestamp BETWEEN ${range.start} AND ${range.stop} AND NOT E.annulled AND E.thread_type = 'T'
      AND E.dept_id IN (${sql.join(depts)})
    GROUP BY E.event_id, day ORDER BY day, H.name`.execute(executor);
  const days = rangeDays(
    range,
    rows.map((r) => r.day),
  );
  const names = [...new Set(rows.map((r) => r.name))].sort();
  const series = names.map((name) => ({
    name,
    data: days.map((d) => Number(rows.find((r) => r.name === name && r.day === d)?.n ?? 0)),
  }));
  return { days, series };
}

/** oltre questo numero di giorni l'intervallo non viene riempito (solo i giorni con eventi) */
const MAX_FILLED_DAYS = 731;

/**
 * Giorni del grafico: tutti quelli dell'intervallo, anche senza eventi (valgono 0), più quelli con dati
 * (calcolati sul fuso del DB, possono sporgere di un giorno). Differenza voluta dal PHP, che usa solo i
 * giorni con eventi: con un solo giorno di dati il grafico sembrerebbe vuoto.
 */
function rangeDays(range: ReportRange, dataDays: string[]): string[] {
  const days = new Set(dataDays);
  const first = DateTime.fromISO(range.startDay ?? "", { zone: "UTC" });
  const last = DateTime.fromISO(range.lastDay ?? "", { zone: "UTC" });
  if (first.isValid && last.isValid && last >= first && last.diff(first, "days").days <= MAX_FILLED_DAYS) {
    for (let d = first; d <= last; d = d.plus({ days: 1 })) days.add(d.toISODate() ?? "");
  }
  return [...days].filter(Boolean).sort();
}

export interface TabularRow {
  key: number;
  label: string;
  opened: number;
  assigned: number;
  overdue: number;
  closed: number;
  reopened: number;
  deleted: number;
  serviceTime: number | null;
  responseTime: number | null;
}

/** getTabularData($group): righe per reparto, help topic o agente, con le stesse restrizioni del PHP. */
export async function tabularData(
  group: TabularGroup,
  agent: Agent,
  range: ReportRange,
  executor: DbOrTx = db(),
): Promise<TabularRow[]> {
  const ev = await eventIds(executor);
  const id = (n: string) => ev[n] ?? -1;
  const depts = agent.deptIds.length ? [...agent.deptIds] : [0];

  let key: RawBuilder<unknown>;
  let label: RawBuilder<unknown>;
  let joins: RawBuilder<unknown>;
  let filter: RawBuilder<unknown>;
  if (group === "dept") {
    key = sql`V.dept_id`;
    label = sql`D.name`;
    joins = sql`JOIN ${table("department")} D ON (D.id = V.dept_id)`;
    filter = sql`V.dept_id IN (${sql.join(depts)})`;
  } else if (group === "topic") {
    key = sql`V.topic_id`;
    label = sql`HT.topic`;
    joins = sql`JOIN ${table("help_topic")} HT ON (HT.topic_id = V.topic_id)`;
    filter = sql`V.dept_id IN (${sql.join(depts)}) AND V.topic_id > 0`;
  } else {
    key = sql`V.staff_id`;
    label = sql`CONCAT_WS(' ', S.firstname, S.lastname)`;
    joins = sql`JOIN ${table("staff")} S ON (S.staff_id = V.staff_id)`;
    // Solo sé stessi, i reparti gestiti e (con stats.agents) i propri reparti
    const managed = (
      await executor.selectFrom("department").select("id").where("manager_id", "=", agent.id).execute()
    ).map((r) => r.id);
    const scope = [...managed, ...(agent.hasGlobalPerm(GlobalPerm.STATS_AGENTS) ? agent.deptIds : [])];
    filter = scope.length
      ? sql`V.staff_id > 0 AND (V.staff_id = ${agent.id} OR V.dept_id IN (${sql.join(scope)}))`
      : sql`V.staff_id > 0 AND V.staff_id = ${agent.id}`;
  }

  const count = (name: string) => sql`COUNT(CASE WHEN V.event_id = ${id(name)} THEN 1 END)`;
  const { rows } = await sql<Omit<TabularRow, "serviceTime" | "responseTime">>`
    SELECT ${key} AS ${sql.ref("key")}, ${label} AS label,
      ${count("created")} AS opened, ${count("assigned")} AS assigned, ${count("overdue")} AS overdue,
      ${count("closed")} AS closed, ${count("reopened")} AS reopened, ${count("deleted")} AS deleted
    FROM ${table("thread_event")} V ${joins}
    WHERE V.annulled = 0 AND V.thread_type = 'T' AND V.timestamp BETWEEN ${range.start} AND ${range.stop} AND ${filter}
    GROUP BY ${key} ORDER BY label`.execute(executor);

  // Tempi medi (ore): servizio = creazione→chiusura; risposta = messaggio→risposta agente (pid)
  const { rows: times } = await sql<{
    key: number;
    service: number | null;
    response: number | null;
  }>`
    SELECT ${key} AS ${sql.ref("key")},
      AVG(TIMESTAMPDIFF(HOUR, EC.timestamp, V.timestamp)) AS service,
      AVG(TIMESTAMPDIFF(HOUR, P.created, R.created)) AS response
    FROM ${table("thread_event")} V
    LEFT JOIN ${table("thread_event")} EC ON (EC.thread_id = V.thread_id AND EC.event_id = ${id("created")}
      AND V.event_id = ${id("closed")} AND V.annulled = 0)
    LEFT JOIN ${table("thread_entry")} R ON (R.thread_id = V.thread_id AND R.type = 'R')
    LEFT JOIN ${table("thread_entry")} P ON (P.id = R.pid)
    ${joins}
    WHERE V.timestamp BETWEEN ${range.start} AND ${range.stop} AND ${filter}
    GROUP BY ${key}`.execute(executor);
  const byKey = new Map(times.map((t) => [Number(t.key), t]));

  return rows.map((r) => {
    const t = byKey.get(Number(r.key));
    return {
      ...r,
      key: Number(r.key),
      opened: Number(r.opened),
      assigned: Number(r.assigned),
      overdue: Number(r.overdue),
      closed: Number(r.closed),
      reopened: Number(r.reopened),
      deleted: Number(r.deleted),
      serviceTime: t?.service == null ? null : Number(t.service),
      responseTime: t?.response == null ? null : Number(t.response),
    };
  });
}
