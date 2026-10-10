import "server-only";

import { sql } from "kysely";

import { fieldKey, type DynamicFieldKind, type DynamicFieldView, type DynamicFormView } from "@/lib/forms/dynamic-field";

import type { ConfigNamespace } from "../../config/config";
import { table, type DbOrTx } from "../../db";
import { safeHtml } from "../../format/sanitize";
import { str, type PhpVal } from "../../php/values";
import { isEditableTo, isRequiredFor, isVisibleTo, plainLabel, type FieldDef, type FormAudience } from "../forms/fields";
import { loadFormDef, loadTopicForms, type FormDef } from "../forms/load";
import type { Agent } from "../staff/staff";
import { DeptFlag } from "./status";

/**
 * Dati per i form di apertura dei ticket (pannello agenti e portale clienti): descrizione dei campi
 * dei form dinamici per i renderer client, opzioni (topic, reparti, SLA, assegnatari, stati),
 * ricerca utenti e conversione del POST nelle `$vars` attese da createTicket/openTicket.
 */

function kindOf(type: string): DynamicFieldKind {
  if (type.startsWith("list-")) return "list";
  switch (type) {
    case "text":
    case "memo":
    case "choices":
    case "bool":
    case "datetime":
    case "phone":
    case "priority":
    case "department":
    case "thread":
    case "files":
    case "timezone":
    case "info":
    case "break":
      return type;
    default:
      return "unsupported";
  }
}

/** Campo → descrizione per il client (solo i campi visibili e modificabili da chi compila) */
export function fieldView(f: FieldDef, audience: FormAudience): DynamicFieldView | null {
  if (f.disabled) return null;
  const kind = kindOf(f.type);
  const info = kind === "info" || kind === "break";
  if (!info && !(isVisibleTo(f, audience) && (isEditableTo(f, audience) || kind === "thread"))) return null;
  if (info && !isVisibleTo(f, audience)) return null;
  const c = f.config;
  const choices = f.choices ? Object.entries(f.choices).map(([value, label]) => ({ value, label })) : undefined;
  return {
    id: f.id,
    name: f.name,
    key: fieldKey(f.id),
    kind,
    type: f.type,
    label: plainLabel(f.label),
    hint: plainLabel(f.hint),
    required: isRequiredFor(f, audience),
    choices,
    multiple: !!c.multiselect,
    config: {
      placeholder: str(c.placeholder as PhpVal) || undefined,
      maxLength: Number(c.length) > 0 ? Number(c.length) : undefined,
      rows: Number(c.rows) > 0 ? Number(c.rows) : undefined,
      html: kind === "thread" || kind === "memo" ? !!c.html : undefined,
      time: kind === "datetime" ? !!c.time : undefined,
      ext: kind === "phone" ? c.ext !== false : undefined,
      desc: kind === "bool" ? plainLabel(str(c.desc as PhpVal)) || undefined : undefined,
      content: kind === "info" ? safeHtml(str(c.content as PhpVal)) : undefined,
      prompt: str(c.prompt as PhpVal) || undefined,
      defaultValue: str(c.default as PhpVal) || undefined,
      attachments: kind === "thread" ? !!c.attachments : undefined,
    },
  };
}

export function formView(def: FormDef, audience: FormAudience): DynamicFormView {
  return {
    id: def.id,
    title: def.title,
    instructions: def.instructions,
    fields: def.fields.map((f) => fieldView(f, audience)).filter((f): f is DynamicFieldView => !!f),
  };
}

/** Form del ticket e dell'utente per il contesto indicato */
export async function baseForms(executor: DbOrTx, cfg: ConfigNamespace, audience: FormAudience) {
  const [ticket, user] = await Promise.all([loadFormDef(executor, cfg, { type: "T" }, audience), loadFormDef(executor, cfg, { type: "U" }, audience)]);
  return { ticket: ticket ? formView(ticket, audience) : null, user: user ? formView(user, audience) : null };
}

/**
 * Form aggiuntivi di un help topic (ajax.php/form/help-topic/<id>): i form diversi da quello del ticket
 * e i campi del form del ticket disattivati dal topic.
 */
export async function topicFormsView(executor: DbOrTx, cfg: ConfigNamespace, topicId: number, audience: FormAudience) {
  const forms = await loadTopicForms(executor, cfg, topicId, audience);
  const disabled: number[] = [];
  const out: DynamicFormView[] = [];
  for (const F of forms) {
    if (F.type === "T") disabled.push(...F.disabled);
    else out.push(formView(F, audience));
  }
  return { forms: out, disabled };
}

interface OpenTicketOptions {
  topics: { id: number; name: string }[];
  depts: { id: number; name: string }[];
  slas: { id: number; name: string }[];
  agents: { id: number; name: string }[];
  teams: { id: number; name: string }[];
  statuses: { id: number; name: string; state: string }[];
  hasMySignature: boolean;
}

/** Opzioni del form di apertura da agente (include/staff/ticket-open.inc.php) */
export async function openTicketOptions(executor: DbOrTx, cfg: ConfigNamespace, agent: Agent): Promise<OpenTicketOptions> {
  const topicsRaw = await executor.selectFrom("help_topic").select(["topic_id", "topic_pid", "topic", "flags", "sort"]).execute();
  const byId = new Map(topicsRaw.map((t) => [t.topic_id, t]));
  const fullName = (id: number): string => {
    const parts: string[] = [];
    const seen = new Set<number>();
    let cur = byId.get(id);
    while (cur && !seen.has(cur.topic_id)) {
      seen.add(cur.topic_id);
      parts.unshift(cur.topic);
      cur = cur.topic_pid ? byId.get(cur.topic_pid) : undefined;
    }
    return parts.join(" / ");
  };
  // Topic::getHelpTopics: attivi (flag 0x0002), ordinati per nome completo o per ordinamento manuale
  const manual = cfg.str("help_topic_sort_mode") === "m";
  const topics = topicsRaw
    .filter((t) => (t.flags ?? 0) & 0x0002)
    .map((t) => ({ id: t.topic_id, name: fullName(t.topic_id), sort: t.sort }))
    .sort((a, b) => (manual ? a.sort - b.sort : a.name.localeCompare(b.name)))
    .map(({ id, name }) => ({ id, name }));

  const deptRows = await executor.selectFrom("department").select(["id", "name", "flags", "pid"]).orderBy("name").execute();
  const deptName = new Map(deptRows.map((d) => [d.id, d.name]));
  const depts = deptRows
    .filter((d) => d.flags & DeptFlag.ACTIVE)
    .map((d) => ({ id: d.id, name: d.pid && deptName.get(d.pid) ? `${deptName.get(d.pid)} / ${d.name}` : d.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const slas = (await executor.selectFrom("sla").select(["id", "name", "flags"]).orderBy("name").execute())
    .filter((s) => s.flags & 0x0001)
    .map((s) => ({ id: s.id, name: s.name }));

  const nameOrder = ["last", "lastfirst", "legal"].includes(cfg.str("agent_name_format"));
  const agents = (
    await executor.selectFrom("staff").select(["staff_id", "firstname", "lastname"]).where("isactive", "=", 1).execute()
  )
    .map((s) => ({ id: s.staff_id, name: nameOrder ? `${s.lastname ?? ""}, ${s.firstname ?? ""}` : `${s.firstname ?? ""} ${s.lastname ?? ""}`.trim() }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const teams = (await executor.selectFrom("team").select(["team_id", "name", "flags"]).orderBy("name").execute())
    .filter((t) => t.flags & 0x0001)
    .map((t) => ({ id: t.team_id, name: t.name }));
  const statuses = (await executor.selectFrom("ticket_status").select(["id", "name", "state", "sort"]).where("state", "in", ["open", "closed"]).orderBy("sort").orderBy("name").execute()).map(
    (s) => ({ id: s.id, name: s.name, state: s.state ?? "" }),
  );
  const sig = await executor.selectFrom("staff").select("signature").where("staff_id", "=", agent.id).executeTakeFirst();
  return { topics, depts, slas, agents, teams, statuses, hasMySignature: !!(sig?.signature ?? "").trim() };
}

export interface UserHit {
  id: number;
  name: string;
  email: string;
}

/** Ricerca utenti per nome o email (ajax.php/users?q=… del form di apertura) */
export async function searchUsers(executor: DbOrTx, q: string, limit = 10): Promise<UserHit[]> {
  const term = q.trim();
  if (term.length < 2) return [];
  const like = `%${term.replace(/([%_\\])/g, "\\$1")}%`;
  const { rows } = await sql<{ id: number; name: string; address: string | null }>`
    SELECT U.id, U.name, E.address FROM ${table("user")} U
    LEFT JOIN ${table("user_email")} E ON (E.id = U.default_email_id)
    WHERE U.name LIKE ${like} OR E.address LIKE ${like}
      OR U.id IN (SELECT user_id FROM ${table("user_email")} WHERE address LIKE ${like})
    ORDER BY U.name LIMIT ${limit}`.execute(executor);
  return rows.map((r) => ({ id: r.id, name: r.name, email: r.address ?? "" }));
}

/** Utenti per id (ripristino delle scelte del form) */
export async function usersByIds(executor: DbOrTx, ids: number[]): Promise<UserHit[]> {
  if (!ids.length) return [];
  const rows = await executor
    .selectFrom("user as u")
    .leftJoin("user_email as e", "e.id", "u.default_email_id")
    .select(["u.id", "u.name", "e.address"])
    .where("u.id", "in", ids)
    .execute();
  return rows.map((r) => ({ id: r.id, name: r.name, email: r.address ?? "" }));
}

/**
 * POST del form (chiavi `f.<id>`) → `$vars` per createTicket: ogni campo per nome (o id se senza
 * nome), valori multipli per scelte/liste multiple, estensione del telefono `<nome>-ext`, corpo del
 * messaggio in `message`.
 */
export function formDataToVars(fd: FormData, forms: (FormDef | DynamicFormView | null)[]): Record<string, unknown> {
  const vars: Record<string, unknown> = {};
  for (const form of forms) {
    if (!form) continue;
    for (const f of form.fields) {
      const key = fieldKey(f.id);
      const varName = f.name || String(f.id);
      const all = fd.getAll(key).map(String);
      const type = f.type;
      if (type === "thread") {
        if (all.length) vars.message = all[0];
        continue;
      }
      if (!all.length) {
        if (type === "bool" && fd.has(`${key}:present`)) vars[varName] = "";
        continue;
      }
      vars[varName] = type === "choices" || type.startsWith("list-") ? (all.length > 1 ? all : all[0]) : all[0];
      if (type === "phone" && fd.has(`${key}-ext`)) vars[`${varName}-ext`] = String(fd.get(`${key}-ext`) ?? "");
    }
  }
  return vars;
}
