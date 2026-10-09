import "server-only";

import { sql } from "kysely";

import type { ConfigNamespace } from "../../config/config";
import { table, type DbOrTx } from "../../db";
import { PersonsName } from "../../format/persons-name";
import { hasData, isPresentationOnly, plainLabel, FieldFlag, type FieldDef } from "../forms/fields";
import { loadFormDef } from "../forms/load";
import { exportQueueTicketIds, type TicketQueue } from "../queue/engine";
import type { Agent } from "../staff/staff";

/**
 * Export CSV delle code dei ticket (ajax.tickets.php queueExport → CustomQueue::export su un
 * CsvExporter, include/class.queue.php e include/class.export.php). È una lettura: stesse colonne,
 * intestazioni, ordine dei ticket e formato (BOM UTF-8, fputcsv con virgolette solo se servono).
 *
 * Differenza: il PHP prepara il file in background e, se l'agente non lo scarica entro qualche
 * secondo, lo invia per email (Exporter::email); qui il file è restituito subito per il download.
 */

/** CustomQueue::getExportableFields(): campi standard + campi del form del ticket (cdata). */
export const STANDARD_EXPORT_FIELDS: [string, string][] = [
  ["number", "Ticket Number"],
  ["created", "Date Created"],
  ["cdata__subject", "Subject"],
  ["user__name", "From"],
  ["user__emails__address", "From Email"],
  ["cdata__priority", "Priority"],
  ["dept_id", "Department"],
  ["topic_id", "Help Topic"],
  ["source", "Source"],
  ["status__id", "Current Status"],
  ["lastupdate", "Last Updated"],
  ["est_duedate", "SLA Due Date"],
  ["sla_id", "SLA Plan"],
  ["duedate", "Due Date"],
  ["closed", "Closed Date"],
  ["isoverdue", "Overdue"],
  ["merged", "Merged"],
  ["linked", "Linked"],
  ["isanswered", "Answered"],
  ["staff_id", "Agent Assigned"],
  ["team_id", "Team Assigned"],
  ["thread_count", "Thread Count"],
  ["reopen_count", "Reopen Count"],
  ["attachment_count", "Attachment Count"],
  ["task_count", "Task Count"],
];

async function ticketFormFields(executor: DbOrTx, cfg: ConfigNamespace): Promise<FieldDef[]> {
  return (await loadFormDef(executor, cfg, { type: "T" }, "staff"))?.fields ?? [];
}

export async function exportableFields(executor: DbOrTx, cfg: ConfigNamespace): Promise<[string, string][]> {
  const cdata: [string, string][] = [];
  for (const f of await ticketFormFields(executor, cfg)) {
    if (f.name === "priority" || !hasData(f) || isPresentationOnly(f) || !(f.flags & FieldFlag.ENABLED)) continue;
    cdata.push([`cdata__${f.name || `field_${f.id}`}`, plainLabel(f.label)]);
  }
  // array + array del PHP: le chiavi già presenti non vengono sovrascritte
  const out = [...STANDARD_EXPORT_FIELDS];
  for (const [k, v] of cdata) if (!out.some(([p]) => p === k)) out.push([k, v]);
  return out;
}

/** CustomQueue::getExportFields(): ereditati dal padre, configurati (queue_export) o standard. */
export async function queueExportFields(executor: DbOrTx, cfg: ConfigNamespace, queue: TicketQueue): Promise<[string, string][]> {
  let fields: [string, string][] = [];
  if (queue.row.parent_id && queue.has(0x0080) && queue.parent) {
    fields = await queueExportFields(executor, cfg, queue.parent);
  } else {
    const rows = await executor.selectFrom("queue_export").select(["path", "heading"]).where("queue_id", "=", queue.id).orderBy("sort").orderBy("id").execute();
    if (rows.length) fields = rows.map((r) => [r.path, r.heading ?? ""]);
    else if (queue.isAQueue) fields = await exportableFields(executor, cfg);
  }
  if (!fields.length) fields = await exportableFields(executor, cfg);
  return fields;
}

/**
 * Campi scelti nel dialogo di export ($_SESSION['Export:Q<id>']['fields']): intersezione con i
 * campi della coda (nel loro ordine), poi quelli scelti mancanti presi dagli esportabili.
 */
export function selectExportFields(fields: [string, string][], selected: string[] | undefined, exportable: [string, string][]): [string, string][] {
  if (!selected) return fields;
  const out = fields.filter(([p]) => selected.includes(p));
  for (const p of selected) {
    if (out.some(([k]) => k === p)) continue;
    const e = exportable.find(([k]) => k === p);
    out.push([p, e ? e[1] : ""]);
  }
  return out;
}

/** fputcsv($fp, $data, $delimiter, '"', ''): virgolette se il campo contiene separatore, virgolette, spazi o a capo. */
export function csvLine(values: string[], delimiter: string): string {
  return (
    values
      .map((v) => (v.includes(delimiter) || /["\n\r\t ]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v))
      .join(delimiter) + "\n"
  );
}

/** Verità di PHP: '' e '0' sono falsi. */
const phpTruthy = (v: unknown) => !(v === null || v === undefined || v === "" || v === "0" || v === 0 || v === false);

interface Lookups {
  depts: Map<number, string>;
  topics: Map<number, string>;
  statuses: Map<number, string>;
  slas: Map<number, string>;
  teams: Map<number, string>;
  staff: Map<number, string>;
  priorities: Map<number, string>;
}

function pathNames<T extends { id: number; pid: number | null; name: string }>(rows: T[]): Map<number, string> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const full = (id: number): string => {
    const parts: string[] = [];
    const seen = new Set<number>();
    let cur = byId.get(id);
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      parts.unshift(cur.name);
      cur = cur.pid ? byId.get(cur.pid) : undefined;
    }
    return parts.join(" / ");
  };
  return new Map(rows.map((r) => [r.id, full(r.id)]));
}

async function loadLookups(executor: DbOrTx, cfg: ConfigNamespace): Promise<Lookups> {
  const [depts, topics, statuses, slas, teams, staff, prios] = await Promise.all([
    executor.selectFrom("department").select(["id", "pid", "name"]).execute(),
    executor.selectFrom("help_topic").select(["topic_id", "topic_pid", "topic"]).execute(),
    executor.selectFrom("ticket_status").select(["id", "name"]).execute(),
    executor.selectFrom("sla").select(["id", "name"]).execute(),
    executor.selectFrom("team").select(["team_id", "name"]).execute(),
    executor.selectFrom("staff").select(["staff_id", "firstname", "lastname"]).execute(),
    executor.selectFrom("ticket_priority").select(["priority_id", "priority_desc"]).execute(),
  ]);
  const fmt = cfg.str("agent_name_format");
  return {
    depts: pathNames(depts.map((d) => ({ id: d.id, pid: d.pid, name: d.name ?? "" }))),
    topics: pathNames(topics.map((t) => ({ id: t.topic_id, pid: t.topic_pid, name: t.topic }))),
    statuses: new Map(statuses.map((s) => [s.id, s.name])),
    slas: new Map(slas.map((s) => [s.id, s.name])),
    teams: new Map(teams.map((t) => [t.team_id, t.name])),
    staff: new Map(staff.map((s) => [s.staff_id, new PersonsName({ first: s.firstname ?? "", last: s.lastname ?? "" }, fmt).toString()])),
    priorities: new Map(prios.map((p) => [p.priority_id, p.priority_desc])),
  };
}

type Row = Record<string, unknown>;

/** QueueColumn::from_query per il percorso indicato (valore visualizzato). */
function render(path: string, row: Row, lk: Lookups, cdataFields: Map<string, FieldDef>): string {
  const num = (k: string) => Number(row[k] ?? 0);
  const yesNo = (b: boolean) => (b ? "Yes" : "No");
  switch (path) {
    case "dept_id":
      return lk.depts.get(num("dept_id")) ?? "";
    case "topic_id":
      return lk.topics.get(num("topic_id")) ?? "";
    case "status__id":
      return lk.statuses.get(num("status_id")) ?? "";
    case "sla_id":
      return lk.slas.get(num("sla_id")) ?? "";
    case "staff_id":
      return lk.staff.get(num("staff_id")) ?? "";
    case "team_id":
      return lk.teams.get(num("team_id")) ?? "";
    case "isoverdue":
    case "isanswered":
      return yesNo(!!num(path));
    case "merged":
      return yesNo((num("flags") & 0x3) !== 0);
    case "linked":
      return yesNo((num("flags") & 0x8) !== 0);
    case "thread_count":
    case "reopen_count":
    case "attachment_count":
    case "task_count":
    case "collaborator_count":
      return String(num(path));
    default:
      if (path.startsWith("cdata__")) {
        const v = row[path];
        if (v === null || v === undefined) return "";
        const f = cdataFields.get(path);
        if (f?.type === "priority") return lk.priorities.get(Number(v)) ?? String(v);
        if (f && (f.type === "choices" || f.type.startsWith("list-")) && f.choices) {
          return String(v)
            .split(",")
            .map((k) => f.choices![k.trim()] ?? k.trim())
            .join(", ");
        }
        if (f?.type === "bool") return phpTruthy(v) ? "Yes" : "No";
        return String(v);
      }
      return row[path] === null || row[path] === undefined ? "" : String(row[path]);
  }
}

export interface ExportOptions {
  /** campi scelti (percorsi), come nel dialogo di export */
  fields?: string[];
  /** separatore (csv-delimiter); default ',' */
  delimiter?: string;
  sort?: string;
  dir?: 0 | 1;
  userTz: string;
}

/** CSV di una coda (contenuto con BOM) e nome del file `<coda> Tickets-<Ymd>.csv`. */
export async function exportQueueCsv(executor: DbOrTx, cfg: ConfigNamespace, agent: Agent, queue: TicketQueue, opts: ExportOptions): Promise<{ filename: string; content: string }> {
  const exportable = await exportableFields(executor, cfg);
  const fields = selectExportFields(await queueExportFields(executor, cfg, queue), opts.fields, exportable);
  const ids = await exportQueueTicketIds(agent, queue, { sort: opts.sort, dir: opts.dir }, { userTz: opts.userTz }, executor);
  const delimiter = opts.delimiter || ",";
  const formFields = await ticketFormFields(executor, cfg);
  const cdataFields = new Map(formFields.map((f) => [`cdata__${f.name || `field_${f.id}`}`, f]));
  const cdataCols = new Set(
    (await sql<{ Field: string }>`SHOW COLUMNS FROM ${table("ticket__cdata")}`.execute(executor).catch(() => ({ rows: [] as { Field: string }[] }))).rows.map((r) => String(r.Field)),
  );

  let content = "﻿" + csvLine(fields.map(([, h]) => h), delimiter);
  if (ids.length) {
    const lk = await loadLookups(executor, cfg);
    const cdataSel = [...cdataCols].filter((c) => c !== "ticket_id").map((c) => sql`C.${sql.ref(c)} AS ${sql.ref(`cdata__${c}`)}`);
    const { rows } = await sql<Row>`
      SELECT T.*, U.name AS user__name, ORG.name AS user__org__name,
        (SELECT E.address FROM ${table("user_email")} E WHERE E.user_id = T.user_id ORDER BY E.id = U.default_email_id DESC, E.id LIMIT 1) AS user__emails__address,
        (SELECT COUNT(H.id) FROM ${table("thread")} TH JOIN ${table("thread_entry")} H ON (H.thread_id = TH.id)
          WHERE TH.object_type = 'T' AND TH.object_id = T.ticket_id AND (H.flags & 4) = 0) AS thread_count,
        (SELECT COUNT(EV.id) FROM ${table("thread")} TH JOIN ${table("thread_event")} EV ON (EV.thread_id = TH.id)
          WHERE TH.object_type = 'T' AND TH.object_id = T.ticket_id AND EV.annulled = 0
            AND EV.event_id = (SELECT id FROM ${table("event")} WHERE name = 'reopened')) AS reopen_count,
        (SELECT COUNT(A.id) FROM ${table("thread")} TH JOIN ${table("thread_entry")} H ON (H.thread_id = TH.id)
          JOIN ${table("attachment")} A ON (A.object_id = H.id AND A.type = 'H')
          WHERE TH.object_type = 'T' AND TH.object_id = T.ticket_id AND A.inline = 0) AS attachment_count,
        (SELECT COUNT(K.id) FROM ${table("task")} K WHERE K.object_type = 'T' AND K.object_id = T.ticket_id) AS task_count,
        (SELECT COUNT(CB.id) FROM ${table("thread")} TH JOIN ${table("thread_collaborator")} CB ON (CB.thread_id = TH.id)
          WHERE TH.object_type = 'T' AND TH.object_id = T.ticket_id) AS collaborator_count
        ${cdataSel.length ? sql`, ${sql.join(cdataSel)}` : sql``}
      FROM ${table("ticket")} T
      LEFT JOIN ${table("user")} U ON (U.id = T.user_id)
      LEFT JOIN ${table("organization")} ORG ON (ORG.id = U.org_id)
      LEFT JOIN ${table("ticket__cdata")} C ON (C.ticket_id = T.ticket_id)
      WHERE T.ticket_id IN (${sql.join(ids)})`.execute(executor);
    const byId = new Map(rows.map((r) => [Number(r.ticket_id), r]));
    for (const id of ids) {
      const row = byId.get(id);
      if (!row) continue;
      // (string) $column->from_query($row) ?: $row[$path] ?: ''
      const values = fields.map(([path]) => {
        const v = render(path, row, lk, cdataFields);
        if (phpTruthy(v)) return v;
        return phpTruthy(row[path]) ? String(row[path]) : "";
      });
      content += csvLine(values, delimiter);
    }
  }
  const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return { filename: `${queue.title} Tickets-${ymd}.csv`, content };
}

/** Etichetta di un campo esportabile (per il dialogo). */
export function exportFieldLabel(fields: [string, string][], path: string): string {
  return fields.find(([p]) => p === path)?.[1] ?? path;
}
