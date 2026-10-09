import "server-only";

import { sql } from "kysely";
import { DateTime } from "luxon";

import type { ConfigNamespace } from "../config/config";
import { table, type DbOrTx } from "../db";
import { htmlChars } from "../format/html";
import { PersonsName } from "../format/persons-name";
import { phpJsonDecode } from "../format/php-json";
import { installConfig } from "../env";
import { ticketAuthToken } from "./message-id";
import { VarBag, type TemplateVariable, type VariableReplacer } from "./variables";

/**
 * Oggetti esposti ai template email, con gli stessi nomi di attributo del PHP (getVar/get<Tag>):
 * ticket, utente/proprietario, agente, reparto, help topic, priorità, stato, team, voce del thread,
 * azienda, date formattate.
 */

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

/**
 * FormattedDate (include/class.format.php): Format::date/datetime/time/daydatetime nel fuso di sistema.
 * Con `date_formats = custom` si usano i pattern della configurazione; altrimenti i formati ICU della
 * lingua di sistema (date SHORT, ora SHORT, "long" = pattern data + " " + pattern ora, "full" = FULL + SHORT).
 */
export class FormattedDate implements TemplateVariable {
  constructor(
    private readonly value: string,
    private readonly cfg: ConfigNamespace,
    private readonly dbZone: string,
  ) {}
  private fmt(kind: "short" | "long" | "time" | "full"): string {
    const dt = DateTime.fromSQL(this.value, { zone: this.dbZone }).setZone(this.cfg.str("default_timezone") || this.dbZone);
    if (!dt.isValid) return "";
    if (this.cfg.str("date_formats") === "custom") {
      const key = { short: "date_format", long: "datetime_format", time: "time_format", full: "daydatetime_format" }[kind];
      return dt.setLocale("en-US").toFormat(this.cfg.str(key) || "MM/dd/y h:mm a");
    }
    const locale = (this.cfg.str("system_language") || "en_US").replace("_", "-");
    const tz = dt.zoneName ?? "UTC";
    // ICU >= 72 (PHP intl) separa l'ora da AM/PM con U+202F; V8 lo riporta a uno spazio normale
    const icu = (o: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat(locale, { ...o, timeZone: tz })
        .formatToParts(dt.toJSDate())
        .map((p, i, all) => (p.type === "literal" && p.value === " " && all[i + 1]?.type === "dayPeriod" ? "\u202f" : p.value))
        .join("");
    switch (kind) {
      case "short": return icu({ dateStyle: "short" });
      case "time": return icu({ timeStyle: "short" });
      case "full": return icu({ dateStyle: "full", timeStyle: "short" });
      default: return `${icu({ dateStyle: "short" })} ${icu({ timeStyle: "short" })}`;
    }
  }
  getVar(tag: string): unknown {
    switch (tag) {
      case "short":
      case "long":
      case "time":
      case "full": return this.fmt(tag);
      case "system":
      case "user": return this.fmt("long");
    }
    return undefined;
  }
  asVar(): string {
    return this.fmt("long");
  }
}

export interface StaffInfo {
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

export interface EntryInfo {
  id: number;
  thread_id: number;
  type: string;
  title: string | null;
  body: string;
  format: string;
  poster: string;
  staff_id: number;
  user_id: number;
  ip_address: string;
  created: string;
  updated: string;
}

/** ThreadEntryBody::display('email') */
export function entryBodyForEmail(body: string, format: string): string {
  if (!body || body === "-") return "(empty)";
  if (format === "html") return body;
  return `<div style="white-space:pre-wrap">${htmlChars(body)}</div>`;
}

export function entryVar(e: EntryInfo, cfg: ConfigNamespace, dbZone: string, staff?: TemplateVariable | null): TemplateVariable {
  const body = entryBodyForEmail(e.body, e.format);
  return new VarBag(
    {
      id: e.id,
      title: e.title ?? "",
      poster: e.poster,
      body,
      message: body,
      ip_address: e.ip_address,
      create_date: new FormattedDate(e.created, cfg, dbZone),
      update_date: new FormattedDate(e.updated, cfg, dbZone),
      staff: staff ?? "",
    },
    body,
  );
}

export interface TicketInfo {
  ticket_id: number;
  number: string;
  user_id: number;
  dept_id: number;
  topic_id: number;
  staff_id: number;
  team_id: number;
  status_id: number;
  source: string;
  created: string;
  closed: string | null;
  lastupdate: string | null;
  duedate: string | null;
  est_duedate: string | null;
}

export async function loadTicketInfo(executor: DbOrTx, ticketId: number): Promise<TicketInfo | null> {
  const t = await executor
    .selectFrom("ticket")
    .select(["ticket_id", "number", "user_id", "dept_id", "topic_id", "staff_id", "team_id", "status_id", "source", "created", "closed", "lastupdate", "duedate", "est_duedate"])
    .where("ticket_id", "=", ticketId)
    .executeTakeFirst();
  return (t as TicketInfo | undefined) ?? null;
}

export interface OwnerInfo {
  id: number;
  name: string;
  email: string;
  org_name: string | null;
}

export async function loadUserContact(executor: DbOrTx, userId: number): Promise<OwnerInfo | null> {
  const u = await executor
    .selectFrom("user as u")
    .leftJoin("user_email as e", "e.id", "u.default_email_id")
    .leftJoin("organization as o", "o.id", "u.org_id")
    .select(["u.id", "u.name", "e.address as email", "o.name as org_name"])
    .where("u.id", "=", userId)
    .executeTakeFirst();
  if (!u) return null;
  return { id: u.id, name: u.name, email: u.email ?? "", org_name: u.org_name ?? null };
}

/** User::getName: nome, o la parte locale dell'email se il nome è vuoto. */
export function userPersonsName(u: OwnerInfo, cfg: ConfigNamespace): PersonsName {
  const raw = u.name || u.email.split("@")[0];
  return new PersonsName(raw, cfg.str("client_name_format"));
}

/** TicketUser::getTicketLink */
export function ticketLink(cfg: ConfigNamespace, t: TicketInfo, contact: { isOwner: boolean; id: number }, withToken: boolean): string {
  const base = cfg.str("helpdesk_url").replace(/\/+$/, "");
  if (withToken && cfg.bool("allow_auth_tokens")) {
    const token = ticketAuthToken({
      isOwner: contact.isOwner,
      contactId: contact.id,
      ticketId: t.ticket_id,
      createDate: t.created,
      secretSalt: installConfig().secretSalt,
    });
    return `${base}/view.php?auth=${encodeURIComponent(token).replace(/%20/g, "+")}`;
  }
  return `${base}/view.php?id=${t.ticket_id}`;
}

/** TicketOwner / Collaborator come destinatario dei template. */
export function contactVar(
  u: OwnerInfo,
  cfg: ConfigNamespace,
  t: TicketInfo | null,
  opts: { isOwner: boolean; contactId: number; numCollaborators: number; answers?: Map<string, string> },
): TemplateVariable {
  const name = userPersonsName(u, cfg);
  return new VarBag(
    {
      name,
      email: u.email,
      id: u.id,
      organization: u.org_name ?? "",
      ticket_link: () => (t ? ticketLink(cfg, t, { isOwner: opts.isOwner, id: opts.contactId }, opts.numCollaborators === 0) : ""),
      ...Object.fromEntries(opts.answers ?? []),
    },
    () => name.toString(),
  );
}

export interface TicketVarDeps {
  info: TicketInfo;
  cfg: ConfigNamespace;
  dbZone: string;
  owner: TemplateVariable | null;
  ownerEmail: string;
  ownerPhone: string;
  answers: Map<string, string>;
  dept: TemplateVariable | null;
  topic: TemplateVariable | null;
  staff: TemplateVariable | null;
  team: TemplateVariable | null;
  status: TemplateVariable | null;
  priority: TemplateVariable | null;
  assigned: string;
  sourceLabel: string;
}

export function ticketVar(d: TicketVarDeps): TemplateVariable {
  const base = d.cfg.str("helpdesk_url").replace(/\/+$/, "");
  const date = (v: string | null | undefined) => (v ? new FormattedDate(v, d.cfg, d.dbZone) : "");
  const fixed: Record<string, unknown> = {
    id: d.info.ticket_id,
    number: d.info.number,
    phone: d.ownerPhone,
    phone_number: d.ownerPhone,
    client_link: `${base}/view.php?t=${d.info.number}`,
    staff_link: `${base}/scp/tickets.php?id=${d.info.ticket_id}`,
    create_date: date(d.info.created),
    due_date: date(d.info.duedate ?? d.info.est_duedate),
    close_date: date(d.info.closed),
    last_update: date(d.info.lastupdate),
    user: d.owner ?? "",
    name: d.owner ? (d.owner.getVar("name", undefined as unknown as VariableReplacer) as PersonsName) : "",
    email: d.ownerEmail,
    dept: d.dept ?? "",
    topic: d.topic ?? "",
    staff: d.staff ?? "",
    team: d.team ?? "",
    status: d.status ?? "",
    priority: d.priority ?? "",
    assigned: d.assigned,
    source: d.sourceLabel,
    subject: d.answers.get("subject") ?? "",
  };
  return {
    getVar(tag: string) {
      // getVar del PHP: casi speciali, poi risposte del form del ticket, poi getter
      if (["phone", "phone_number", "client_link", "staff_link", "create_date", "due_date", "close_date", "last_update", "user"].includes(tag)) return fixed[tag];
      if (d.answers.has(tag) && tag !== "priority") return d.answers.get(tag);
      return fixed[tag];
    },
    asVar() {
      return d.info.number;
    },
  };
}

const SOURCES: Record<string, string> = { Web: "Web", Email: "Email", Phone: "Phone", API: "API", Other: "Other" };

/** Costruisce tutti gli oggetti di un ticket per i template (Ticket::replaceVars). */
export async function buildTicketVars(executor: DbOrTx, ticketId: number, cfg: ConfigNamespace, dbZone: string) {
  const info = await loadTicketInfo(executor, ticketId);
  if (!info) return null;
  const [owner, answers, dept, topic, staff, collabs, statusRow, ownerAnswers, teamRow] = await Promise.all([
    loadUserContact(executor, info.user_id),
    formAnswerMap(executor, "T", ticketId),
    deptVar(executor, info.dept_id, cfg),
    topicVar(executor, info.topic_id),
    loadStaffInfo(executor, info.staff_id),
    sql<{ n: number }>`SELECT COUNT(*) AS n FROM ${table("thread_collaborator")} C JOIN ${table("thread")} T ON (T.id = C.thread_id)
      WHERE T.object_type = 'T' AND T.object_id = ${ticketId}`.execute(executor),
    executor.selectFrom("ticket_status").select(["id", "name", "state"]).where("id", "=", info.status_id).executeTakeFirst(),
    formAnswerMap(executor, "U", info.user_id),
    info.team_id ? executor.selectFrom("team").select(["team_id", "name"]).where("team_id", "=", info.team_id).executeTakeFirst() : Promise.resolve(undefined),
  ]);
  const prio = await executor
    .selectFrom("ticket__cdata as c")
    .innerJoin("ticket_priority as p", (j) => j.on(sql<boolean>`p.priority_id = c.priority`))
    .select(["p.priority_id", "p.priority", "p.priority_desc", "p.priority_color", "p.priority_urgency"])
    .where("c.ticket_id", "=", ticketId)
    .executeTakeFirst()
    .catch(() => undefined);
  const numCollaborators = Number(collabs.rows[0]?.n ?? 0);
  const ownerVar = owner ? contactVar(owner, cfg, info, { isOwner: true, contactId: owner.id, numCollaborators, answers: ownerAnswers }) : null;
  const staffV = staff ? staffVar(staff, cfg) : null;
  const assigned = [staffV ? staffV.asVar(undefined as unknown as VariableReplacer) : "", teamRow?.name ?? ""].filter(Boolean).join("/");
  const ticket = ticketVar({
    info,
    cfg,
    dbZone,
    owner: ownerVar,
    ownerEmail: owner?.email ?? "",
    ownerPhone: ownerAnswers.get("phone") ?? "",
    answers,
    dept,
    topic,
    staff: staffV,
    team: teamRow ? new VarBag({ name: teamRow.name, id: teamRow.team_id }, teamRow.name) : null,
    status: statusRow ? new VarBag({ name: statusRow.name, state: statusRow.state, id: statusRow.id }, statusRow.name) : null,
    priority: prio ? new VarBag({ desc: prio.priority_desc, priority: prio.priority, color: prio.priority_color, id: prio.priority_id }, prio.priority_desc) : null,
    assigned,
    sourceLabel: SOURCES[info.source] ?? info.source,
  });
  return { info, ticket, owner, ownerVar, numCollaborators, dept, staff: staffV };
}
