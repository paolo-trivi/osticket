import "server-only";

import { sql } from "kysely";

import { CustomQueue, Dept, DynamicForm, Schedule } from "@/lib/osticket/flags";
import { FormType } from "@/lib/osticket/object-types";

import { db, type DbOrTx } from "../../db";
import { PersonsName } from "../../format/persons-name";
import { helpTopicsSnapshot } from "./topic";

/** Opzioni dei menu a tendina dei form admin (elenchi di oggetti osTicket). */
interface Opt {
  value: string;
  label: string;
}

/** Reparti con il nome completo "Padre / Figlio" (Dept::getDepartments). */
export async function deptOptions(executor: DbOrTx = db()): Promise<(Opt & { active: boolean; ispublic: boolean })[]> {
  const rows = await executor.selectFrom("department").select(["id", "pid", "name", "flags", "ispublic"]).execute();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const full = (id: number, seen = new Set<number>()): string => {
    const r = byId.get(id);
    if (!r) return "";
    if (r.pid && !seen.has(r.pid) && byId.has(r.pid)) return `${full(r.pid, new Set([...seen, id]))} / ${r.name}`;
    return r.name;
  };
  return rows
    .map((r) => ({ value: String(r.id), label: full(r.id), active: !!(r.flags & Dept.ACTIVE), ispublic: !!r.ispublic }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export async function roleOptions(executor: DbOrTx = db()): Promise<Opt[]> {
  const rows = await executor.selectFrom("role").select(["id", "name"]).orderBy("name").execute();
  return rows.map((r) => ({ value: String(r.id), label: r.name ?? "" }));
}

export async function staffOptions(executor: DbOrTx = db(), format = "full"): Promise<Opt[]> {
  const rows = await executor.selectFrom("staff").select(["staff_id", "firstname", "lastname", "isactive"]).orderBy("firstname").orderBy("lastname").execute();
  return rows.map((r) => ({ value: String(r.staff_id), label: new PersonsName({ first: r.firstname ?? "", last: r.lastname ?? "" }, format).toString() }));
}

export async function teamOptions(executor: DbOrTx = db()): Promise<Opt[]> {
  const rows = await executor.selectFrom("team").select(["team_id", "name"]).orderBy("name").execute();
  return rows.map((r) => ({ value: String(r.team_id), label: r.name }));
}

export async function slaOptions(executor: DbOrTx = db()): Promise<Opt[]> {
  const rows = await executor.selectFrom("sla").select(["id", "name", "grace_period", "flags"]).orderBy("name").execute();
  return rows.map((r) => ({ value: String(r.id), label: `${r.name} (${r.grace_period}h)` }));
}

export async function scheduleOptions(executor: DbOrTx = db(), type?: "bizhrs" | "hdays"): Promise<Opt[]> {
  let q = executor.selectFrom("schedule").select(["id", "name", "flags"]).orderBy("name");
  if (type === "bizhrs") q = q.where(sql<boolean>`(flags & ${sql.lit(Schedule.BIZHRS)}) != 0`);
  if (type === "hdays") q = q.where(sql<boolean>`(flags & ${sql.lit(Schedule.BIZHRS)}) = 0`);
  return (await q.execute()).map((r) => ({ value: String(r.id), label: r.name }));
}

export async function emailOptions(executor: DbOrTx = db()): Promise<Opt[]> {
  const rows = await executor.selectFrom("email").select(["email_id", "email", "name"]).orderBy("email").execute();
  return rows.map((r) => ({ value: String(r.email_id), label: r.name ? `${r.name} <${r.email}>` : r.email }));
}

export async function templateOptions(executor: DbOrTx = db()): Promise<Opt[]> {
  const rows = await executor.selectFrom("email_template_group").select(["tpl_id", "name"]).orderBy("name").execute();
  return rows.map((r) => ({ value: String(r.tpl_id), label: r.name }));
}

export async function priorityOptions(executor: DbOrTx = db()): Promise<Opt[]> {
  const rows = await executor.selectFrom("ticket_priority").select(["priority_id", "priority_desc"]).orderBy("priority_urgency", "desc").execute();
  return rows.map((r) => ({ value: String(r.priority_id), label: r.priority_desc }));
}

export async function statusOptions(executor: DbOrTx = db(), states?: string[]): Promise<Opt[]> {
  let q = executor.selectFrom("ticket_status").select(["id", "name", "state"]).orderBy("sort");
  if (states) q = q.where("state", "in", states);
  return (await q.execute()).map((r) => ({ value: String(r.id), label: r.name }));
}

export async function pageOptions(executor: DbOrTx = db(), type?: string): Promise<Opt[]> {
  let q = executor.selectFrom("content").select(["id", "name", "type"]).orderBy("name");
  if (type) q = q.where("type", "=", type);
  return (await q.execute()).map((r) => ({ value: String(r.id), label: r.name }));
}

export async function sequenceOptions(executor: DbOrTx = db()): Promise<Opt[]> {
  const rows = await executor.selectFrom("sequence").select(["id", "name"]).orderBy("name").execute();
  return rows.map((r) => ({ value: String(r.id), label: r.name ?? "" }));
}

export async function topicOptions(executor: DbOrTx = db()): Promise<(Opt & { active: boolean })[]> {
  const list = await helpTopicsSnapshot(executor);
  return list.map((t) => ({ value: String(t.id), label: t.name, active: !t.disabled })).sort((a, b) => a.label.localeCompare(b.label));
}

export async function queueOptions(executor: DbOrTx = db()): Promise<(Opt & { parent: number; sort: number })[]> {
  const rows = await executor.selectFrom("queue").select(["id", "parent_id", "title", "sort"]).where(sql<boolean>`(flags & ${sql.lit(CustomQueue.QUEUE)}) != 0`).orderBy("parent_id").orderBy("sort").execute();
  return rows.map((r) => ({ value: String(r.id), label: r.title ?? "", parent: r.parent_id, sort: r.sort }));
}

/** Form dinamici con i campi (per i form associati agli help topic). */
export async function formsWithFields(executor: DbOrTx = db()): Promise<{ id: number; title: string; type: string; fields: Opt[] }[]> {
  const forms = await executor.selectFrom("form").select(["id", "title", "type"]).where("type", "in", [FormType.TICKET, FormType.GENERIC]).where(sql<boolean>`(flags & ${sql.lit(DynamicForm.DELETED)}) = 0`).orderBy("title").execute();
  const out = [];
  for (const f of forms) {
    const fields = await executor.selectFrom("form_field").select(["id", "label"]).where("form_id", "=", f.id).orderBy("sort").execute();
    out.push({ id: f.id, title: f.title ?? "", type: f.type ?? "", fields: fields.map((x) => ({ value: String(x.id), label: x.label })) });
  }
  return out;
}

/** Elenco dei fusi orari IANA (DateTimeZone::listIdentifiers). */
export function timezoneOptions(): Opt[] {
  const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : ["UTC", "Europe/Rome"];
  return zones.map((z) => ({ value: z, label: z }));
}

/** File caricati come logo (ft 'L') o sfondo (ft 'B'), selezionabili nella pagina Azienda. */
export async function brandingFiles(executor: DbOrTx = db()): Promise<{ logos: Opt[]; backdrops: Opt[] }> {
  const rows = await executor.selectFrom("file").select(["id", "name", "ft"]).where("ft", "in", ["L", "B"]).orderBy("id").execute();
  return {
    logos: rows.filter((r) => r.ft === "L").map((r) => ({ value: String(r.id), label: r.name })),
    backdrops: rows.filter((r) => r.ft === "B").map((r) => ({ value: String(r.id), label: r.name })),
  };
}
