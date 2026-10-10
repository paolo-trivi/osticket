import "server-only";

import { sql } from "kysely";

import type { ConfigNamespace } from "../config/config";
import { table, type DbOrTx } from "../db";
import { PersonsName } from "../format/persons-name";
import { phpJsonDecode } from "../format/php-json";
import { VarBag, type TemplateVariable } from "./variables";

/** Oggetti dell'organizzazione nei template: risposte dei form come testo, agente, azienda, reparto, help topic. */

/** Rappresentazione testuale di una risposta di form dinamico (DynamicFormEntryAnswer::toString). */
export function answerToString(type: string, value: string | null): string {
  if (value === null || value === undefined) return "";
  if (type === "choices" || type.startsWith("list-") || type === "assignees") {
    const parsed = phpJsonDecode<Record<string, string> | string[] | null>(value, null);
    if (parsed && typeof parsed === "object") return Object.values(parsed).join(", ");
  }
  if (type === "bool") return value && value !== "0" ? "Yes" : "No";
  return value;
}

export async function formAnswerMap(executor: DbOrTx, objectType: string, objectId: number): Promise<Map<string, string>> {
  const { rows } = await sql<{ name: string; type: string; value: string | null }>`
    SELECT FF.name, FF.type, V.value FROM ${table("form_entry")} FE
    JOIN ${table("form_entry_values")} V ON (V.entry_id = FE.id)
    JOIN ${table("form_field")} FF ON (FF.id = V.field_id)
    WHERE FE.object_type = ${objectType} AND FE.object_id = ${objectId} AND FF.name != ''
    ORDER BY FE.sort, FF.sort`.execute(executor);
  const out = new Map<string, string>();
  for (const r of rows) if (!out.has(r.name.toLowerCase())) out.set(r.name.toLowerCase(), answerToString(r.type, r.value));
  return out;
}

interface StaffInfo {
  staff_id: number;
  firstname: string;
  lastname: string;
  email: string;
  username: string;
  signature: string;
  phone: string;
  mobile: string;
  dept_id: number;
  timezone: string | null;
}

export async function loadStaffInfo(executor: DbOrTx, staffId: number): Promise<StaffInfo | null> {
  if (!staffId) return null;
  const row = await executor
    .selectFrom("staff")
    .select(["staff_id", "firstname", "lastname", "email", "username", "signature", "phone", "mobile", "dept_id", "timezone"])
    .where("staff_id", "=", staffId)
    .executeTakeFirst();
  return (row as StaffInfo | undefined) ?? null;
}

export function staffVar(s: StaffInfo, cfg: ConfigNamespace): TemplateVariable {
  const name = new PersonsName({ first: s.firstname, last: s.lastname }, cfg.str("agent_name_format"));
  return new VarBag(
    {
      name,
      firstname: s.firstname,
      lastname: s.lastname,
      email: s.email,
      username: s.username,
      signature: s.signature,
      phone: s.phone,
      mobile: s.mobile,
      timezone: s.timezone ?? "",
      id: s.staff_id,
    },
    () => name.toString(),
  );
}

export async function companyVar(executor: DbOrTx): Promise<TemplateVariable> {
  // La riga form_entry dell'azienda ha object_type 'C' (object_id vuoto)
  const { rows } = await sql<{ name: string; type: string; value: string | null }>`
    SELECT FF.name, FF.type, V.value FROM ${table("form_entry")} FE
    JOIN ${table("form_entry_values")} V ON (V.entry_id = FE.id)
    JOIN ${table("form_field")} FF ON (FF.id = V.field_id)
    WHERE FE.object_type = 'C' AND FF.name != '' ORDER BY FE.id, FF.sort`.execute(executor);
  const answers = new Map<string, string>();
  for (const r of rows) if (!answers.has(r.name.toLowerCase())) answers.set(r.name.toLowerCase(), answerToString(r.type, r.value));
  const values = Object.fromEntries(answers);
  return new VarBag(values, () => answers.get("name") ?? "");
}

export async function deptVar(executor: DbOrTx, deptId: number, cfg: ConfigNamespace): Promise<TemplateVariable | null> {
  const d = await executor.selectFrom("department").select(["id", "name", "signature", "manager_id", "ispublic"]).where("id", "=", deptId).executeTakeFirst();
  if (!d) return null;
  const manager = await loadStaffInfo(executor, d.manager_id ?? 0);
  return new VarBag(
    {
      id: d.id,
      name: d.name,
      signature: d.signature,
      manager: manager ? staffVar(manager, cfg) : "",
    },
    d.name,
  );
}

export async function topicVar(executor: DbOrTx, topicId: number): Promise<TemplateVariable | null> {
  if (!topicId) return null;
  const all = await executor.selectFrom("help_topic").select(["topic_id", "topic_pid", "topic"]).execute();
  const byId = new Map(all.map((t) => [t.topic_id, t]));
  const t = byId.get(topicId);
  if (!t) return null;
  const path: string[] = [];
  let cur: typeof t | undefined = t;
  const seen = new Set<number>();
  while (cur && !seen.has(cur.topic_id)) {
    seen.add(cur.topic_id);
    path.unshift(cur.topic);
    cur = cur.topic_pid ? byId.get(cur.topic_pid) : undefined;
  }
  return new VarBag({ id: t.topic_id, name: t.topic, fullname: path.join(" / ") }, t.topic);
}
