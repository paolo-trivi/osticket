import "server-only";

import { sql } from "kysely";
import { DateTime } from "luxon";

import { NOW, table, type DbOrTx } from "../../db";
import { phpJsonEncode } from "../../format/php-json";
import { PersonsName } from "../../format/persons-name";
import type { MailContact } from "../../mail/mailer";
import { logSystem } from "../../system/syslog";
import { attachFilesToEntry, type AttachInput } from "../file/upload";
import {
  actionEventData,
  applyFilterActions,
  filterInput,
  loadActiveFilters,
  originToTarget,
  prepareSupportedMatches,
  TicketRejected,
  type FilterAction,
  type TicketVars,
} from "../filter/ticket-filter";
import { FormInstance, saveFormEntry } from "../forms/entry";
import {
  cleanFromDb,
  FieldFlag,
  fieldToString,
  hasFlag,
  isEmail,
  isRequiredFor,
  isVisibleTo,
  type DateFormatOptions,
  type FieldDef,
  type FieldErrorCode,
} from "../forms/fields";
import { loadFormDef, loadTopicForms, type FormDef } from "../forms/load";
import { loadAgent, TicketPerm } from "../staff/staff";
import { createThreadEntry, EntryFlag, type EntryRecipients } from "../thread/write";
import { deleteDraftsFor, isEmailBanned } from "./collab";
import { agentDisplayName, type WriteContext } from "./context";
import { onAssignAlert, onNewTicket, onOpenLimit, sendFilterEmail, sendNewTicketNotice } from "./create-alerts";
import { postCannedReply } from "./create-canned";
import { newTicketNumber } from "./create-number";
import { loadOrganization, lookupUser, lookupUserByEmail, organizationForDomain, userEmail, userFromVars, type UserRow } from "./create-user";
import { logTicketEvent, type Actor } from "./events";
import { postNote, postReply } from "./post";
import { SQL_NOW, TicketRecord } from "./record";
import { DeptFlag, isSelectableStatus, loadStatus, setTicketStatus, stateOf, updateEstDueDate } from "./status";

/**
 * Creazione dei ticket (Ticket::create / Ticket::open, include/class.ticket.php): validazione dei form
 * dinamici, utente, filtri, limite dei ticket aperti, numerazione, primo messaggio con allegati,
 * SLA, stato, assegnazione, eventi, indice, notifiche. Servizio riusabile dal pannello agenti
 * (origine "staff") e dal portale clienti (origine "web").
 */

export type CreateOrigin = "staff" | "web";

/**
 * Dati della richiesta come `$vars` del PHP. Campi noti:
 * - utente: `uid` oppure `email`, `name` (+ altri campi del form utente per nome o id);
 * - `topicId`, `deptId`, `slaId`, `priorityId`, `statusId`, `duedate` (agente), `source` (agente);
 * - `subject`, `message` (corpo HTML o testo) e gli altri campi dei form per nome o id;
 * - `files`: allegati del messaggio già caricati [{id, name}];
 * - `ccs`: id utente dei collaboratori; `ip`.
 */
export type CreateTicketVars = Record<string, unknown>;

export interface CreateErrors {
  err?: string;
  errno?: number;
  topicId?: string;
  deptId?: string;
  duedate?: string;
  source?: string;
  user?: string;
  email?: string;
  name?: string;
  assignId?: string;
  /** errori dei campi dei form dinamici (id campo → codici) */
  fields?: Record<number, FieldErrorCode[]>;
}

export type CreateResult =
  | { ok: true; ticketId: number; number: string; messageId: number | null; threadId: number }
  | { ok: false; errors: CreateErrors };

export const TICKET_SOURCES = ["Phone", "Email", "Web", "API", "Other"] as const;

const TopicFlagActive = 0x0002;
const OrgFlag = { COLLAB_ALL_MEMBERS: 0x0001, COLLAB_PRIMARY_CONTACT: 0x0002, ASSIGN_AGENT_MANAGER: 0x0004 } as const;

const isNum = (v: unknown) => v !== undefined && v !== null && v !== "" && v !== false && /^\s*[+-]?(\d+\.?\d*|\.\d+)\s*$/.test(String(v));
const truthy = (v: unknown) => !(v === undefined || v === null || v === false || v === "" || v === "0" || v === 0);

interface TopicRow {
  topic_id: number;
  topic_pid: number;
  flags: number;
  noautoresp: number;
  sequence_id: number;
  number_format: string | null;
  priority_id: number;
  dept_id: number;
  staff_id: number;
  team_id: number;
  sla_id: number;
  status_id: number;
  topic: string;
}

async function loadTopic(executor: DbOrTx, id: number): Promise<TopicRow | null> {
  if (!id) return null;
  const t = await executor
    .selectFrom("help_topic")
    .select(["topic_id", "topic_pid", "flags", "noautoresp", "sequence_id", "number_format", "priority_id", "dept_id", "staff_id", "team_id", "sla_id", "status_id", "topic"])
    .where("topic_id", "=", id)
    .executeTakeFirst();
  return t ? { ...t, flags: t.flags ?? 0 } : null;
}

/** Topic::getFullName: percorso "Padre / Figlio" */
async function topicFullName(executor: DbOrTx, t: TopicRow): Promise<string> {
  const all = await executor.selectFrom("help_topic").select(["topic_id", "topic_pid", "topic"]).execute();
  const byId = new Map(all.map((r) => [r.topic_id, r]));
  const parts: string[] = [];
  const seen = new Set<number>();
  let cur: { topic_id: number; topic_pid: number; topic: string } | undefined = byId.get(t.topic_id);
  while (cur && !seen.has(cur.topic_id)) {
    seen.add(cur.topic_id);
    parts.unshift(cur.topic);
    cur = cur.topic_pid ? byId.get(cur.topic_pid) : undefined;
  }
  return parts.join(" / ") || t.topic;
}

async function deptIsActive(executor: DbOrTx, id: number): Promise<boolean> {
  const d = await executor.selectFrom("department").select("flags").where("id", "=", id).executeTakeFirst();
  return !!d && (d.flags & DeptFlag.ACTIVE) !== 0;
}

async function topicIsActive(executor: DbOrTx, id: number): Promise<boolean> {
  const t = await executor.selectFrom("help_topic").select("flags").where("topic_id", "=", id).executeTakeFirst();
  return !!t && ((t.flags ?? 0) & TopicFlagActive) !== 0;
}

/** Risposte salvate di un oggetto (utente/organizzazione) come dati per i filtri: field.<id> → testo */
async function entryFilterData(
  ctx: WriteContext,
  objectType: "U" | "O",
  objectId: number,
  special: Record<string, string>,
  dates: DateFormatOptions,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const entries = await ctx.tx.selectFrom("form_entry").select(["id", "form_id"]).where("object_type", "=", objectType).where("object_id", "=", objectId).orderBy("sort").orderBy("id").execute();
  for (const e of entries) {
    const def = await loadFormDef(ctx.tx, ctx.cfg, { id: e.form_id });
    if (!def) continue;
    const values = await ctx.tx.selectFrom("form_entry_values").select(["field_id", "value", "value_id"]).where("entry_id", "=", e.id).execute();
    const local: Record<string, string> = {};
    for (const v of values) {
      const f = def.fields.find((x) => x.id === v.field_id);
      if (!f) continue;
      const s = fieldToString(f, cleanFromDb(f, v.value, v.value_id), dates);
      if (s) local[`field.${f.id}`] = s;
    }
    if (def.type === objectType) {
      for (const [name, val] of Object.entries(special)) {
        const f = def.fields.find((x) => x.name === name);
        if (f) local[`field.${f.id}`] = val;
      }
    }
    for (const [k, v] of Object.entries(local)) if (!(k in out)) out[k] = v;
  }
  return out;
}

/** $cfg->getTimezone(): fuso dell'agente, altrimenti del cliente autenticato, altrimenti default_timezone */
async function currentTimezone(ctx: WriteContext): Promise<string> {
  if (ctx.agent?.row.timezone) return ctx.agent.row.timezone;
  if (ctx.actor?.kind === "user") {
    const a = await ctx.tx.selectFrom("user_account").select("timezone").where("user_id", "=", ctx.actor.id).executeTakeFirst();
    if (a?.timezone) return a.timezone;
  }
  return ctx.cfg.str("default_timezone") || "UTC";
}

const addMissing = (vars: TicketVars, data: Record<string, unknown>) => {
  for (const [k, v] of Object.entries(data)) if (!(k in vars)) vars[k] = v;
};

/**
 * Ticket::filterTicketData: dati dei form e dell'utente/organizzazione, banlist, filtri.
 * Prima della creazione può lanciare TicketRejected; dopo la creazione registra gli eventi "edited".
 */
async function filterTicketData(
  ctx: WriteContext,
  origin: CreateOrigin,
  input: TicketVars,
  forms: FormInstance[],
  user: UserRow | null,
  post: { rec: TicketRecord; threadId: number } | null,
  dates: DateFormatOptions,
): Promise<TicketVars> {
  const vars: TicketVars = {};
  for (const [k, v] of Object.entries(input)) if (!k.startsWith("field.")) vars[k] = v;
  for (const F of forms) addMissing(vars, { ...F.filterData(), ...(await F.listFilterData(ctx.tx)) });

  let userForm: FormInstance | null = null;
  if (!user) {
    const def = await loadFormDef(ctx.tx, ctx.cfg, { type: "U" });
    if (def) {
      userForm = new FormInstance(def, vars, 1, null, { dates });
      for (const n of ["name", "email"]) {
        const f = userForm.field(n);
        if (f) vars[n] = fieldToString(f, userForm.values.get(f.id) ?? null, dates);
      }
    }
    user = await lookupUserByEmail(ctx.tx, String(vars.email ?? ""));
  }
  if (user) {
    const email = await userEmail(ctx.tx, user);
    addMissing(vars, await entryFilterData(ctx, "U", user.id, { name: user.name, email }, dates));
    vars.email = email;
    vars.name = user.name;
    const org = await loadOrganization(ctx.tx, user.org_id);
    if (org) addMissing(vars, await entryFilterData(ctx, "O", org.id, { name: org.name }, dates));
  } else {
    if (userForm) for (const f of userForm.fields) vars[`field.${f.id}`] = fieldToString(f, userForm.values.get(f.id) ?? null, dates);
    const domain = String(vars.email ?? "").split("@")[1] ?? "";
    const org = await organizationForDomain(ctx.tx, domain);
    if (org) addMissing(vars, await entryFilterData(ctx, "O", org.id, { name: org.name }, dates));
  }

  if (await isEmailBanned(ctx.tx, String(vars.email ?? ""))) throw new TicketRejected("SYSTEM BAN LIST", String(vars.email ?? ""));

  await prepareSupportedMatches(ctx.tx);
  const filters = await loadActiveFilters(ctx.tx, originToTarget(origin), Number(vars.emailId ?? 0));
  const checks = { isActive: (id: number) => deptIsActive(ctx.tx, id), topicIsActive: (id: number) => topicIsActive(ctx.tx, id) };
  const submitter = { name: String(vars.name ?? ""), email: String(vars.email ?? "") };
  const sendEmail = post ? (a: FilterAction) => sendFilterEmail(ctx, post.rec.id, a.config, submitter) : undefined;
  const applied = await applyFilterActions(filters, filterInput(vars), vars, !!post, checks, sendEmail);
  if (post) {
    for (const f of applied) {
      for (const a of f.actions) {
        const data = await actionEventData(ctx.tx, a, f.name);
        if (data) await logTicketEvent(ctx.tx, post.rec.row, post.threadId, ctx.actor, "edited", data, "Ticket Filter");
      }
    }
  }
  return vars;
}

/** Numero di ticket aperti dell'utente (TicketUser::getNumOpenTickets, inclusi quelli da collaboratore) */
async function numOpenTickets(ctx: WriteContext, userId: number): Promise<number> {
  const collab = ctx.cfg.bool("collaborator_ticket_visibility");
  const { rows } = await sql<{ n: number }>`SELECT COUNT(DISTINCT T.ticket_id) AS n FROM ${table("ticket")} T
    JOIN ${table("ticket_status")} S ON (S.id = T.status_id)
    LEFT JOIN ${table("thread")} TH ON (TH.object_type = 'T' AND TH.object_id = T.ticket_id)
    LEFT JOIN ${table("thread_collaborator")} C ON (C.thread_id = TH.id)
    WHERE S.state = 'open' AND (T.user_id = ${userId} ${collab ? sql`OR C.user_id = ${userId}` : sql``})`.execute(ctx.tx);
  return Number(rows[0]?.n ?? 0);
}

/** Contatti di Ticket::getRecipients($who, $whitelist) con ids come MailingList::getEmailAddresses */
async function ticketRecipients(ctx: WriteContext, ownerId: number, threadId: number, who: string, whitelist?: number[]) {
  const nameOf = (name: string, email: string) => new PersonsName(name || email.split("@")[0], ctx.cfg.str("client_name_format")).toString();
  const to: { listId: number; userId: number; name: string; email: string }[] = [];
  const cc: { listId: number; userId: number; name: string; email: string }[] = [];
  const w = who.toLowerCase();
  if (!["user", "all", "collabs"].includes(w)) return null;
  const contact = async (uid: number) =>
    ctx.tx
      .selectFrom("user as u")
      .leftJoin("user_email as e", "e.id", "u.default_email_id")
      .select(["u.id", "u.name", "e.address"])
      .where("u.id", "=", uid)
      .executeTakeFirst();
  if (w === "user" || w === "all") {
    const o = await contact(ownerId);
    if (o) to.push({ listId: o.id, userId: o.id, name: nameOf(o.name, o.address ?? ""), email: o.address ?? "" });
  }
  if (w === "all" || w === "collabs") {
    // Thread::getCollaborators: order_by('user__name')
    const collabs = await ctx.tx
      .selectFrom("thread_collaborator as c")
      .innerJoin("user as u", "u.id", "c.user_id")
      .select(["c.id", "c.user_id", "c.flags"])
      .where("c.thread_id", "=", threadId)
      .orderBy("u.name")
      .orderBy("c.id")
      .execute();
    for (const c of collabs) {
      if (!(c.flags & 1)) continue;
      if (whitelist?.length && !whitelist.includes(c.user_id)) continue;
      const u = await contact(c.user_id);
      if (u) cc.push({ listId: c.id, userId: c.user_id, name: nameOf(u.name, u.address ?? ""), email: u.address ?? "" });
    }
  }
  return { to, cc };
}

function recipientsJson(r: { to: { listId: number; name: string; email: string }[]; cc: { listId: number; name: string; email: string }[] }): EntryRecipients {
  const out: EntryRecipients = {};
  for (const [k, list] of [["to", r.to], ["cc", r.cc]] as const) {
    if (!list.length) continue;
    out[k] = list.map((c): [string, string] => [String(c.listId), `${c.name} <${c.email}>`]);
  }
  return out;
}

/** Thread::addCollaborator + Ticket::addCollaborator (flag ACTIVE|CC) con evento collab */
async function addCollaborator(ctx: WriteContext, rec: TicketRecord, threadId: number, userId: number, logEvent = true): Promise<boolean> {
  if (userId === rec.get("user_id")) return false;
  const exists = await ctx.tx.selectFrom("thread_collaborator").select("id").where("thread_id", "=", threadId).where("user_id", "=", userId).executeTakeFirst();
  if (exists) return false;
  const user = await lookupUser(ctx.tx, userId);
  if (!user) return false;
  let flags = 0x0001 | 0x0002;
  // disable_agent_collabs per i ticket creati dai clienti: collaboratore inattivo se l'email è di un agente
  if (!ctx.agent && ctx.cfg.bool("disable_agent_collabs")) {
    const email = await userEmail(ctx.tx, user);
    const staff = email ? await ctx.tx.selectFrom("staff").select("staff_id").where("email", "=", email).executeTakeFirst() : undefined;
    if (staff) flags = 0x0002;
  }
  await ctx.tx.insertInto("thread_collaborator").values({ flags, thread_id: threadId, user_id: userId, role: "M", created: NOW, updated: NOW }).execute();
  if (logEvent) await logTicketEvent(ctx.tx, rec.row, threadId, ctx.actor, "collab", { add: { [String(userId)]: { name: user.name } } });
  return true;
}

/** Ticket::assignToStaff (auto-assegnazione di topic/filtri/organizzazione) */
async function assignToStaff(ctx: WriteContext, rec: TicketRecord, threadId: number, staffId: number, alert: boolean, who: string): Promise<boolean> {
  const staff = await loadAgent(staffId, ctx.tx);
  if (!staff || !staff.isAvailable) return false;
  rec.set("staff_id", staff.id);
  await rec.save();
  if (alert) await onAssignAlert(ctx, { ticketId: rec.id, deptId: rec.get("dept_id") }, { kind: "staff", id: staff.id }, "", null);
  const data = ctx.agent && ctx.agent.id === staff.id ? { claim: true } : { staff: staff.id };
  await logTicketEvent(ctx.tx, rec.row, threadId, ctx.actor, "assigned", data, who);
  await ctx.tx.deleteFrom("thread_referral").where("thread_id", "=", threadId).where("object_type", "=", "S").where("object_id", "=", staff.id).execute();
  return true;
}

/** Ticket::assignToTeam */
async function assignToTeam(ctx: WriteContext, rec: TicketRecord, threadId: number, teamId: number, alert: boolean, who: string): Promise<boolean> {
  const team = await ctx.tx.selectFrom("team").select(["team_id", "flags"]).where("team_id", "=", teamId).executeTakeFirst();
  if (!team || !(team.flags & 0x0001)) return false;
  rec.set("team_id", team.team_id);
  await rec.save();
  if ((await stateOf(ctx.tx, rec.row)) === "closed") {
    rec.set("staff_id", 0);
    await rec.save();
  }
  if (alert) await onAssignAlert(ctx, { ticketId: rec.id, deptId: rec.get("dept_id") }, { kind: "team", id: team.team_id }, "", null);
  await logTicketEvent(ctx.tx, rec.row, threadId, ctx.actor, "assigned", { team: team.team_id }, who);
  await ctx.tx.deleteFrom("thread_referral").where("thread_id", "=", threadId).where("object_type", "=", "E").where("object_id", "=", team.team_id).execute();
  return true;
}

/** Dept::canAssign per un agente */
async function deptCanAssignStaff(ctx: WriteContext, deptId: number, staffId: number): Promise<boolean> {
  const d = await ctx.tx.selectFrom("department").select(["id", "flags", "manager_id"]).where("id", "=", deptId).executeTakeFirst();
  const staff = await loadAgent(staffId, ctx.tx);
  if (!d || !staff) return false;
  if (d.flags & DeptFlag.ASSIGN_PRIMARY_ONLY && staff.deptId !== d.id) return false;
  if (d.flags & DeptFlag.ASSIGN_MEMBERS_ONLY) {
    const member = staff.deptId === d.id || d.manager_id === staff.id || staff.extendedAccess.some((a) => a.deptId === d.id);
    if (!member) return false;
  }
  return staff.isAvailable;
}

/**
 * Ticket::assign(AssignmentForm) dall'apertura da agente (`assignId` = s<id> | t<id>, commenti = nota).
 */
async function assignFromForm(ctx: WriteContext, rec: TicketRecord, threadId: number, assignId: string, comments: string): Promise<string | true> {
  const kind = assignId[0];
  const id = Number(assignId.slice(1));
  let alert = true;
  let evd: Record<string, unknown>;
  let assignee: { kind: "staff"; id: number } | { kind: "team"; id: number };
  let assigneeName: string;
  if (kind === "s") {
    const staff = await loadAgent(id, ctx.tx);
    if (!staff) return "Unknown assignee";
    if (rec.get("staff_id") === staff.id) return "Ticket already assigned to the agent";
    if (!staff.isAvailable) return "Agent is unavailable for assignment";
    if (!(await deptCanAssignStaff(ctx, rec.get("dept_id"), staff.id))) return "Permission denied";
    rec.set("staff_id", staff.id);
    if (ctx.agent && ctx.agent.id === staff.id) {
      alert = false;
      evd = { claim: true };
    } else evd = { staff: [staff.id, staff.name.full] };
    assignee = { kind: "staff", id: staff.id };
    assigneeName = agentDisplayName(staff, ctx.cfg);
    await ctx.tx.deleteFrom("thread_referral").where("thread_id", "=", threadId).where("object_type", "=", "S").where("object_id", "=", staff.id).execute();
  } else if (kind === "t") {
    const team = await ctx.tx.selectFrom("team").select(["team_id", "name", "flags"]).where("team_id", "=", id).executeTakeFirst();
    if (!team) return "Unknown assignee";
    if (rec.get("team_id") === team.team_id) return "Ticket already assigned to the team";
    const members = await ctx.tx.selectFrom("team_member").select("staff_id").where("team_id", "=", team.team_id).execute();
    if (!(team.flags & 0x0001) || !members.length) return "Permission denied";
    rec.set("team_id", team.team_id);
    evd = { team: team.team_id };
    assignee = { kind: "team", id: team.team_id };
    assigneeName = team.name;
    await ctx.tx.deleteFrom("thread_referral").where("thread_id", "=", threadId).where("object_type", "=", "E").where("object_id", "=", team.team_id).execute();
  } else return "Unknown assignee";
  await rec.save(true);
  await logTicketEvent(ctx.tx, rec.row, threadId, ctx.actor, "assigned", evd);
  // onAssign: nota con i commenti (senza avvisi) e avviso assigned.alert
  let note: { id: number; threadId: number } | null = null;
  if (comments) {
    const title =
      assignee.kind === "staff" && ctx.agent && assignee.id === ctx.agent.id
        ? `Ticket claimed by ${agentDisplayName(ctx.agent, ctx.cfg)}`
        : `Ticket Assigned to ${assigneeName}`;
    const r = await postNote(ctx, { ticketId: rec.id, note: comments, title, format: "html", alert: false });
    if ("entryId" in r) note = { id: r.entryId, threadId };
    await rec.reload();
  }
  if (alert) await onAssignAlert(ctx, { ticketId: rec.id, deptId: rec.get("dept_id") }, assignee, comments, note);
  return true;
}

/**
 * Fuso con cui il PHP interpreta la scadenza: bootstrap.php imposta date_default_timezone 'UTC' e
 * Misc::user2gmtime/Format::parseDateTime fanno `new DateTime($input)` prima di setTimezone(), quindi un
 * valore senza offset è letto come UTC (il fuso dell'agente è ignorato). Stranezza replicata: la UI invia
 * la scadenza in ISO con offset esplicito, interpretata correttamente da entrambi.
 */
const PHP_TZ = "UTC";

/** Data/ora inserita (strtotime / new DateTime) → DateTime, null se non interpretabile */
function parseUserDate(value: string, zone: string): DateTime | null {
  const v = value.trim();
  for (const dt of [DateTime.fromISO(v, { zone }), DateTime.fromSQL(v, { zone }), DateTime.fromFormat(v, "MM/dd/yyyy", { zone }), DateTime.fromFormat(v, "MM/dd/yy", { zone })]) {
    if (dt.isValid) return dt;
  }
  return null;
}

export interface CreateOptions {
  autorespond?: boolean;
  alertstaff?: boolean;
}

/**
 * Ticket::create($vars, $errors, $origin, $autorespond, $alertstaff).
 * Va eseguito dentro runWrite: ctx.agent è l'agente (origine staff) o null (portale), ctx.actor il
 * cliente autenticato o null per un ospite.
 */
export async function createTicket(ctx: WriteContext, input: CreateTicketVars, origin: CreateOrigin, opts: CreateOptions = {}): Promise<CreateResult> {
  const { tx, cfg } = ctx;
  let autorespond = opts.autorespond ?? true;
  const alertstaff = opts.alertstaff ?? true;
  const audience = origin === "staff" ? "staff" : "client";
  const include = (f: FieldDef) => isVisibleTo(f, audience);
  // DynamicFormField::getField: obbligatorietà per agente se c'è $thisstaff, altrimenti per cliente
  const requiredFor = (f: FieldDef) => isRequiredFor(f, ctx.agent ? "staff" : "client");
  let vars: TicketVars = { ...input };
  const errors: CreateErrors = {};
  const fail = (): CreateResult => ({ ok: false, errors });
  const requestIp = String(input.ip ?? "") || ctx.actor?.ip || "";

  const ticketDef = await loadFormDef(tx, cfg, { type: "T" }, audience);
  if (!ticketDef) throw new Error("Form dei ticket mancante");
  // Regola più stretta del PHP: dal portale si accettano solo i campi visibili ai clienti
  const sourceFor = (def: FormDef): TicketVars => {
    if (origin !== "web") return vars;
    const allowed = new Set(def.fields.filter((f) => isVisibleTo(f, "client") || f.type === "thread").flatMap((f) => [f.name, String(f.id)]));
    return Object.fromEntries(Object.entries(vars).filter(([k]) => allowed.has(k) || !def.fields.some((f) => f.name === k || String(f.id) === k)));
  };
  const dates: DateFormatOptions = { cfg, timezone: await currentTimezone(ctx) };
  const form = new FormInstance(ticketDef, sourceFor(ticketDef), 1, null, { dates });

  let user: UserRow | null = isNum(vars.uid) ? await lookupUser(tx, Number(vars.uid)) : null;

  // Validator::process per origine
  const required = (k: string, msg: string, type: "int" | "string" | "date") => {
    const v = vars[k];
    if (v === undefined || v === null || v === "") return void (errors[k as keyof CreateErrors] = msg as never);
    if (type === "int" && !isNum(v)) errors[k as keyof CreateErrors] = msg as never;
  };
  const optional = (k: string, msg: string, type: "int" | "date") => {
    const v = vars[k];
    if (v === undefined || v === null || v === "") return;
    if (type === "int" && !isNum(v)) errors[k as keyof CreateErrors] = msg as never;
    if (type === "date" && !parseUserDate(String(v), PHP_TZ)) errors[k as keyof CreateErrors] = msg as never;
  };
  if (origin === "web") required("topicId", "Select a Help Topic", "int");
  else {
    optional("deptId", "Department selection is required", "int");
    required("topicId", "Help topic selection is required", "int");
    optional("duedate", "Invalid date format - must be MM/DD/YY", "date");
    required("source", "Indicate ticket source", "string");
  }
  if (Object.keys(errors).length && !errors.err) errors.err = "Missing or invalid data — Correct any errors below and try again";

  let duedate: DateTime | null = null;
  if (truthy(vars.duedate)) {
    duedate = parseUserDate(String(vars.duedate), PHP_TZ);
    if (!duedate) errors.duedate = "Invalid due date";
    else if (duedate.toMillis() <= Date.now()) errors.duedate = "Due date must be in the future";
  }

  const topicForms: FormInstance[] = [];
  if (!Object.keys(errors).length) {
    if (truthy(vars.topicId)) {
      const t = await loadTopic(tx, Number(vars.topicId));
      if (t) {
        const tforms = await loadTopicForms(tx, cfg, t.topic_id, audience);
        tforms.forEach((F, idx) => {
          const disabled = F.fields.filter((f) => f.disabled && hasFlag(f, FieldFlag.ENABLED)).map((f) => f.id);
          const extra = phpJsonEncode({ disable: disabled });
          if (F.type === "T") {
            for (const f of form.fields) if (disabled.includes(f.id)) f.disabled = true;
            form.sort = idx;
            form.extra = extra;
          } else topicForms.push(new FormInstance(F, sourceFor(F), idx, extra, { dates }));
        });
      }
    }

    try {
      vars = await filterTicketData(ctx, origin, vars, [form, ...topicForms], user, null, dates);
    } catch (ex) {
      if (!(ex instanceof TicketRejected)) throw ex;
      await logSystem("Warning", "Ticket denied", `Ticket rejected (${ex.email}) by filter "${ex.filterName}"`, requestIp, { executor: tx });
      return { ok: false, errors: { errno: 403, err: "This help desk is for use by authorized users only" } };
    }

    const max = cfg.int("max_open_tickets");
    if (max > 0 && origin !== "staff") {
      const u = await lookupUserByEmail(tx, String(vars.email ?? ""));
      const open = u ? await numOpenTickets(ctx, u.id) : 0;
      if (open && open >= max) {
        await logSystem("Warning", `Ticket denied - ${String(vars.email)}`, `Max open tickets (${max}) reached for ${String(vars.email)}`, requestIp, { executor: tx });
        return { ok: false, errors: { err: "You've reached the maximum open tickets allowed." } };
      }
    }

    if (!user && vars.email) user = await lookupUserByEmail(tx, String(vars.email));
    if (!user) {
      const udef = await loadFormDef(tx, cfg, { type: "U" }, audience);
      const canCreate = !ctx.agent || ctx.agent.hasGlobalPerm("user.create");
      let ok = false;
      if (udef) {
        const uform = new FormInstance(udef, vars, 1, null, { dates });
        const uerr = await uform.validate(include, requiredFor, cfg);
        if (!Object.keys(uerr).length) {
          const clean: Record<string, unknown> = {};
          for (const f of udef.fields) {
            const v = uform.values.get(f.id) ?? null;
            clean[String(f.id)] = v;
            if (f.name) clean[f.name] = v;
          }
          if (canCreate) {
            user = await userFromVars(tx, cfg, clean, true, dates);
            ok = !!user;
          }
        } else errors.fields = { ...errors.fields, ...uerr };
      }
      if (!ok) errors.user = canCreate ? "Incomplete client information" : "You do not have permission to create users.";
    }
  }

  const ferr = await form.validate(include, requiredFor, cfg);
  if (Object.keys(ferr).length) errors.fields = { ...errors.fields, ...ferr };
  let topic: TopicRow | null = null;
  if (truthy(vars.topicId)) {
    const t = isNum(vars.topicId) ? await loadTopic(tx, Number(vars.topicId)) : null;
    // Stranezza PHP replicata: `$topic = Topic::lookup()` è assegnato nella condizione, quindi un topic
    // esistente ma disattivato resta in uso (reparto, priorità, numerazione…) anche se topicId diventa 0.
    if (t) topic = t;
    if (t && t.flags & TopicFlagActive) {
      for (const tf of topicForms) {
        const e = await tf.validate(include, requiredFor, cfg);
        if (Object.keys(e).length) errors.fields = { ...errors.fields, ...e };
      }
    } else vars.topicId = 0;
  }
  if (Object.keys(errors).length || !user) return fail();

  if (vars.autorespond !== undefined) autorespond = !!vars.autorespond;
  if (truthy(vars.priorityId)) {
    const p = await prioritySelection(tx, Number(vars.priorityId));
    if (p) form.setAnswer("priority", p);
  }
  let statusId = Number(vars.statusId ?? 0) || 0;
  // Stato scelto dall'agente: solo quelli della select (abilitati, open/closed), vedi isSelectableStatus;
  // altrimenti si usa lo stato dell'argomento o quello predefinito, come senza scelta
  if (statusId && !isSelectableStatus(await loadStatus(tx, statusId))) statusId = 0;
  let deptId = Number(vars.deptId ?? 0) || 0;
  let source = String(vars.source ?? "");
  source = source.charAt(0).toUpperCase() + source.slice(1);

  if (!topic) topic = await loadTopic(tx, cfg.int("default_help_topic"));
  const hasPriority = () => {
    const f = form.field("priority");
    return !!f && !!form.effective(f);
  };
  if (topic) {
    deptId = deptId || topic.dept_id;
    statusId = statusId || topic.status_id;
    if (!hasPriority()) {
      const p = await prioritySelection(tx, topic.priority_id);
      if (p) form.setAnswer("priority", p);
    }
    if (autorespond) autorespond = !topic.noautoresp;
    if (vars.staffId === undefined && topic.staff_id) vars.staffId = topic.staff_id;
    else if (vars.teamId === undefined && topic.team_id) vars.teamId = topic.team_id;
    if (vars.slaId !== undefined && !truthy(vars.slaId)) delete vars.slaId;
    if (vars.slaId !== undefined) vars.slaId = vars.slaId || cfg.int("default_sla_id");
    else if (topic.sla_id) vars.slaId = topic.sla_id;
  }

  const org = await loadOrganization(tx, user.org_id);
  if (org && org.status & OrgFlag.ASSIGN_AGENT_MANAGER && org.manager) {
    if (vars.staffId === undefined && org.manager[0] === "s") vars.staffId = Number(org.manager.slice(1));
    else if (vars.teamId === undefined && org.manager[0] === "t") vars.teamId = Number(org.manager.slice(1));
  }

  if (!hasPriority()) {
    const p = await prioritySelection(tx, cfg.int("default_priority_id"));
    if (p) form.setAnswer("priority", p);
  }
  deptId = deptId || cfg.int("default_dept_id");
  statusId = statusId || cfg.int("default_ticket_status_id", 1);
  const topicId = topic ? topic.topic_id : 0;
  const ip = String(vars.ip ?? "") || requestIp;
  source = source || "Web";

  const number = await newTicketNumber(tx, cfg, topic);
  let dbDuedate: string | null = null;
  if (duedate && (origin === "staff")) dbDuedate = duedate.setZone(ctx.dbZone).toFormat("yyyy-MM-dd HH:mm:00");
  const ins = await tx
    .insertInto("ticket")
    .values({
      number,
      user_id: user.id,
      dept_id: deptId,
      topic_id: topicId,
      ip_address: ip,
      source: source as (typeof TICKET_SOURCES)[number],
      email_id: Number(vars.emailId ?? 0) || 0,
      duedate: dbDuedate,
      created: NOW,
      lastupdate: NOW,
      updated: NOW,
    })
    .executeTakeFirstOrThrow();
  const ticketId = Number(ins.insertId);
  const th = await tx.insertInto("thread").values({ object_id: ticketId, object_type: "T", created: NOW }).executeTakeFirstOrThrow();
  const threadId = Number(th.insertId);
  const rec = (await TicketRecord.load(tx, ticketId, true))!;

  // Form del ticket: oggetto vuoto → nome completo del topic
  const subj = form.field("subject");
  if (subj && !form.effective(subj) && topic) form.setValue("subject", await topicFullName(tx, topic));
  await saveFormEntry(tx, form, "T", ticketId);
  for (const tf of topicForms) await saveFormEntry(tx, tf, "T", ticketId);

  // Evento "created" (agente o utente)
  // $thisstaff ?: $user: (string) User = nome nel formato client_name_format
  const creator: Actor = ctx.agent
    ? ctx.actor
    : { kind: "user", id: user.id, name: new PersonsName(user.name, cfg.str("client_name_format")).toString(), email: String(vars.email ?? ""), hasAccount: false, ip };
  await logTicketEvent(tx, rec.row, threadId, ctx.actor, "created", null, creator);

  if (rec.get("status_id") <= 0) {
    rec.set("status_id", cfg.int("default_ticket_status_id", 1));
    await rec.save();
  }

  // Collaboratori
  const ccs = Array.isArray(vars.ccs) ? (vars.ccs as unknown[]).map(Number).filter((n) => n > 0) : [];
  for (const uid of ccs) await addCollaborator(ctx, rec, threadId, uid);
  if (org && org.status & (OrgFlag.COLLAB_ALL_MEMBERS | OrgFlag.COLLAB_PRIMARY_CONTACT)) {
    const members = await tx.selectFrom("user").select(["id", "status"]).where("org_id", "=", org.id).orderBy("id").execute();
    let added = 0;
    for (const m of members) {
      if (org.status & OrgFlag.COLLAB_ALL_MEMBERS || (org.status & OrgFlag.COLLAB_PRIMARY_CONTACT && m.status & 0x0001)) {
        if (await addCollaborator(ctx, rec, threadId, m.id)) added++;
      }
    }
    if (added) await logTicketEvent(tx, rec.row, threadId, ctx.actor, "collab", { org: org.id });
  }

  // Primo messaggio (postMessage senza avvisi)
  const subject = form.get("subject");
  let recipients: EntryRecipients | undefined;
  if (truthy(vars["reply-to"])) {
    const r = await ticketRecipients(ctx, user.id, threadId, String(vars["reply-to"]), ccs);
    if (r) recipients = recipientsJson(r);
  } else {
    const r = await ticketRecipients(ctx, user.id, threadId, "all");
    if (r) recipients = recipientsJson({ to: r.to.filter((c) => c.userId !== user!.id), cc: r.cc.filter((c) => c.userId !== user!.id) });
  }
  const messageBody = String(vars.message ?? "");
  let messageId: number | null = null;
  const fmt = cfg.bool("enable_richtext") ? "html" : "text";
  if (messageBody && (fmt === "text" ? messageBody.trim() : messageBody.replace(/^[\s<>br/]+|[\s<>br/]+$/g, ""))) {
    const entry = await createThreadEntry(tx, cfg, {
      threadId,
      type: "M",
      body: messageBody,
      format: fmt,
      title: typeof subject === "string" ? subject : "",
      staffId: 0,
      userId: user.id,
      poster: new PersonsName(user.name, cfg.str("client_name_format")).toString(),
      source: String(input.source ?? ""),
      ip,
      recipients: recipients && Object.keys(recipients).length ? recipients : undefined,
      editorSpacing: !!ctx.actor,
    });
    messageId = entry.id;
    const files = (Array.isArray(vars.files) ? (vars.files as AttachInput[]) : []).filter((f) => f && Number(f.id) > 0);
    if (files.length) await attachFilesToEntry(tx, entry.id, files.map((f) => ({ id: Number(f.id), name: f.name ?? null, inline: !!f.inline })));
    await tx.updateTable("thread").set({ lastmessage: NOW }).where("id", "=", threadId).execute();
    // onMessage: non risposto, lastupdate
    rec.set("isanswered", 0);
    rec.set("lastupdate", SQL_NOW as never);
    await rec.save();
  }

  // Filtri post-creazione: eventi "edited" (e azioni email)
  await filterTicketData(ctx, origin, vars, [form, ...topicForms], user, { rec, threadId }, dates);

  if (messageId) {
    await tx
      .updateTable("thread_entry")
      .set({ flags: sql<number>`flags | ${EntryFlag.ORIGINAL_MESSAGE}` })
      .where("id", "=", messageId)
      .execute();
  }

  // SLA (selectSLAId)
  const dept = await tx.selectFrom("department").select(["id", "sla_id", "ticket_auto_response"]).where("id", "=", rec.get("dept_id")).executeTakeFirst();
  let slaId = 0;
  if (truthy(vars.slaId) && isNum(vars.slaId)) slaId = Number(vars.slaId);
  else if (dept?.sla_id) slaId = dept.sla_id;
  else if (topic?.sla_id) slaId = topic.sla_id;
  else slaId = cfg.int("default_sla_id");
  if (slaId && slaId !== rec.get("sla_id")) {
    const exists = await tx.selectFrom("sla").select("id").where("id", "=", slaId).executeTakeFirst();
    if (exists) {
      rec.set("sla_id", slaId);
      await rec.save();
    }
  }

  // Stato
  const status = await tx.selectFrom("ticket_status").select("id").where("id", "=", statusId).executeTakeFirst();
  const statusOk = status
    ? await setTicketStatus(ctx, rec, threadId, statusId, {
        setClosingAgent: origin === "staff",
        logNote: async (title, body) => {
          await postNote(ctx, { ticketId: rec.id, note: body, title, format: "html" });
          await rec.reload();
        },
      })
    : false;
  if (statusOk !== true) {
    rec.set("status_id", cfg.int("default_ticket_status_id", 1));
    await rec.save();
  }

  // Assegnazione (solo ticket aperti)
  if ((await stateOf(tx, rec.row)) === "open") {
    if (truthy(vars.assignId)) {
      await assignFromForm(ctx, rec, threadId, String(vars.assignId), String(vars.note ?? ""));
    } else {
      if (truthy(vars.staffId)) await assignToStaff(ctx, rec, threadId, Number(vars.staffId), true, "Ticket Filter");
      if (truthy(vars.teamId)) await assignToTeam(ctx, rec, threadId, Number(vars.teamId), !truthy(vars.staffId), "Ticket Filter");
    }
  }

  await updateEstDueDate(ctx, rec);

  // Controlli dell'auto-risposta
  const ownerEmail = await userEmail(tx, user);
  if (autorespond && (await tx.selectFrom("email").select("email_id").where("email", "=", ownerEmail).executeTakeFirst())) autorespond = false;
  // Risposta predefinita automatica da filtro (disattiva l'auto-risposta del nuovo ticket)
  if (truthy(vars.cannedResponseId) && (await postCannedReply(ctx, rec, threadId, Number(vars.cannedResponseId), autorespond, requestIp))) autorespond = false;
  if (autorespond && dept && !dept.ticket_auto_response) autorespond = false;

  await onNewTicket(ctx, { ticketId: rec.id, threadId, deptId: rec.get("dept_id"), messageId: messageId ?? 0, ownerId: user.id }, autorespond, alertstaff);

  const max = cfg.int("max_open_tickets");
  if (max > 0 && (await numOpenTickets(ctx, user.id)) === max) {
    await onOpenLimit(ctx, { ticketId: rec.id, deptId: rec.get("dept_id"), email: ownerEmail, ip: requestIp, numOpenTickets: () => numOpenTickets(ctx, user.id) }, autorespond && origin !== "staff");
  }

  return { ok: true, ticketId: rec.id, number: rec.get("number"), messageId, threadId };
}

async function prioritySelection(executor: DbOrTx, id: number): Promise<{ id: number; label: string } | null> {
  if (!id) return null;
  const p = await executor.selectFrom("ticket_priority").select(["priority_id", "priority_desc"]).where("priority_id", "=", id).executeTakeFirst();
  return p ? { id: p.priority_id, label: p.priority_desc } : null;
}

export interface OpenTicketInput extends CreateTicketVars {
  /** risposta iniziale (opzionale) */
  response?: string;
  /** nota interna (opzionale; commenti dell'assegnazione se c'è assignId) */
  note?: string;
  /** notifica: all | user | none */
  "reply-to"?: string;
  signature?: "none" | "mine" | "dept";
  /** s<id> | t<id> */
  assignId?: string;
  /** allegati della risposta iniziale */
  responseFiles?: AttachInput[];
}

/**
 * Ticket::open($vars, $errors): apertura da agente con controlli dei permessi, risposta iniziale,
 * nota interna e notifica `ticket.notice`.
 */
export async function openTicket(ctx: WriteContext, input: OpenTicketInput, opts: CreateOptions = {}): Promise<CreateResult> {
  const { tx, cfg, agent } = ctx;
  const errors: CreateErrors = {};
  if (!agent) return { ok: false, errors: { err: "forbidden" } };
  if (!agent.hasPermInAnyRole(TicketPerm.CREATE)) return { ok: false, errors: { err: "You do not have permission to create tickets" } };

  let role = null;
  if (truthy(input.deptId)) {
    const dept = await tx.selectFrom("department").select("id").where("id", "=", Number(input.deptId)).executeTakeFirst();
    if (dept) {
      role = agent.roleFor(dept.id);
      if (!role.perms.has(TicketPerm.CREATE)) return { ok: false, errors: { err: "You do not have permission to create a ticket in this department" } };
    }
  }
  if (input.source !== undefined && !(TICKET_SOURCES as readonly string[]).includes(String(input.source))) errors.source = `Invalid source given - ${String(input.source)}`;
  if (!truthy(input.uid)) {
    if (!input.email || !isEmail(String(input.email))) errors.email = "Valid email address is required";
    if (!input.name) errors.name = "Name is required";
  }
  // Regola più stretta del PHP: un ruolo "solo creazione" (reparto senza accesso) non consente l'assegnazione
  if (truthy(input.assignId) && !(role ? role.perms.has(TicketPerm.ASSIGN) : agent.hasPermInAnyRole(TicketPerm.ASSIGN))) {
    errors.assignId = "Action Denied. You are not allowed to assign/reassign tickets.";
  }

  const createVars: CreateTicketVars = { ...input };
  delete createVars.response;
  delete createVars.responseFiles;
  if (Object.keys(errors).length) return { ok: false, errors };
  const res = await createTicket(ctx, createVars, "staff", { ...opts, autorespond: false });
  if (!res.ok) return res;
  // scp/tickets.php: dopo l'apertura si eliminano le bozze dell'agente 'ticket.staff%'
  // (qui prima delle notifiche, che partono comunque dopo il commit)
  await deleteDraftsFor(tx, "ticket.staff%", agent.id);

  const rec = (await TicketRecord.load(tx, res.ticketId, true))!;
  const assigned = rec.get("staff_id") === agent.id || agent.isTeamMember(rec.get("team_id"));
  const ticketRole = agent.roleFor(rec.get("dept_id"), (await stateOf(tx, rec.row)) === "open" && assigned);
  const replyTo = String(input["reply-to"] ?? "all");
  const alert = replyTo.toLowerCase() !== "none";
  let responseId = 0;
  const responseText = String(input.response ?? "");
  if (responseText && ticketRole.perms.has(TicketPerm.REPLY)) {
    const r = await postReply(ctx, {
      ticketId: rec.id,
      response: responseText,
      replyTo,
      ccs: Array.isArray(input.ccs) ? (input.ccs as unknown[]).map(Number) : undefined,
      signature: input.signature,
      alert: alert && !cfg.bool("ticket_notice_active"),
      files: input.responseFiles,
      source: input.source === undefined ? undefined : String(input.source),
    });
    if ("entryId" in r) responseId = r.entryId;
  }
  if (!truthy(input.assignId) && input.note) {
    await postNote(ctx, { ticketId: rec.id, note: String(input.note), title: "New Ticket", format: cfg.bool("enable_richtext") ? "html" : "text", alert: false });
  }

  if (!cfg.bool("ticket_notice_active") || !alert) return res;
  await rec.reload();
  const recipients = await ticketRecipients(ctx, rec.get("user_id"), res.threadId, replyTo);
  if (!recipients) return res;
  const contacts = (list: { name: string; email: string }[]): MailContact[] => list.map((c) => ({ name: c.name, address: c.email }));
  await sendNewTicketNotice(
    ctx,
    { ticketId: rec.id, threadId: res.threadId, deptId: rec.get("dept_id"), messageId: res.messageId ?? 0, responseId },
    { to: contacts(recipients.to), cc: contacts(recipients.cc) },
    String(input.signature ?? "none"),
  );
  return res;
}
