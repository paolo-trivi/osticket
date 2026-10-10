import "server-only";

import { sql } from "kysely";
import { DateTime } from "luxon";

import { OrganizationModel, ThreadEntry, Topic, UserModel } from "@/lib/osticket/flags";
import { FormType, ObjectType, ThreadEntryType } from "@/lib/osticket/object-types";

import { NOW } from "../../db";
import { PersonsName } from "../../format/persons-name";
import { isNumeric, truthy as phpTruthy, type PhpVal } from "../../php/values";
import { logSystem } from "../../system/syslog";
import { attachFilesToEntry, type AttachInput } from "../file/upload";
import { TicketRejected, type TicketVars } from "../filter/ticket-filter";
import { currentTimezone, FormInstance, saveFormEntry } from "../forms/entry";
import { isRequiredFor, isVisibleTo, type DateFormatOptions, type FieldDef, type FieldErrorCode } from "../forms/fields";
import { loadFormDef, type FormDef } from "../forms/load";
import { createThreadEntry, type EntryRecipients } from "../thread/write";
import type { WriteContext } from "./context";
import { onNewTicket, onOpenLimit } from "./create-alerts";
import { assignFromForm, autoAssignToStaff, autoAssignToTeam } from "./create-assign";
import { postCannedReply } from "./create-canned";
import { addCollaborator, recipientsJson, ticketRecipients } from "./create-collab";
import { filterTicketData } from "./create-filter";
import { newTicketNumber } from "./create-number";
import { loadTopic, prioritySelection, topicFormInstances, topicFullName, type TopicRow } from "./create-topic";
import { loadOrganization, lookupUser, lookupUserByEmail, numOpenTickets, userEmail, userFromVars, type UserRow } from "./create-user";
import { logTicketEvent, type Actor } from "./events";
import { postNote } from "./post";
import { SQL_NOW, TicketRecord } from "./record";
import { isSelectableStatus, loadStatus, setTicketStatus, stateOf, updateEstDueDate } from "./status";

/**
 * Creazione dei ticket (Ticket::create, include/class.ticket.php): validazione dei form dinamici, utente,
 * filtri, limite dei ticket aperti, numerazione, primo messaggio con allegati, SLA, stato, assegnazione,
 * eventi, indice, notifiche. Servizio riusabile dal pannello agenti (origine "staff", vedi create-open.ts
 * per Ticket::open) e dal portale clienti (origine "web").
 * Responsabilità secondarie nei moduli vicini: argomento e default (create-topic), filtri (create-filter),
 * assegnazione (create-assign), collaboratori e destinatari (create-collab), utente (create-user).
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

/** is_numeric() e (bool) di PHP sui $vars (valori ignoti trattati come PhpVal) */
const isNum = (v: unknown) => isNumeric(v as PhpVal);
const truthy = (v: unknown) => phpTruthy(v as PhpVal);

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

  const ticketDef = await loadFormDef(tx, cfg, { type: FormType.TICKET }, audience);
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
    if (truthy(vars.topicId)) topicForms.push(...(await topicFormInstances(tx, cfg, Number(vars.topicId), audience, form, sourceFor, dates)));

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
      const udef = await loadFormDef(tx, cfg, { type: FormType.USER }, audience);
      const canCreate = !ctx.agent || ctx.agent.hasGlobalPerm("user.create");
      let ok = false;
      if (udef) {
        const uform = new FormInstance(udef, vars, 1, null, { dates });
        const uerr = await uform.validate(include, requiredFor, cfg);
        if (!Object.keys(uerr).length) {
          if (canCreate) {
            user = await userFromVars(tx, cfg, uform.cleanVars(), { dates });
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
    if (t && t.flags & Topic.ACTIVE) {
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
  if (org && org.status & OrganizationModel.ASSIGN_AGENT_MANAGER && org.manager) {
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
  const th = await tx.insertInto("thread").values({ object_id: ticketId, object_type: ObjectType.TICKET, created: NOW }).executeTakeFirstOrThrow();
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
  if (org && org.status & (OrganizationModel.COLLAB_ALL_MEMBERS | OrganizationModel.COLLAB_PRIMARY_CONTACT)) {
    const members = await tx.selectFrom("user").select(["id", "status"]).where("org_id", "=", org.id).orderBy("id").execute();
    let added = 0;
    for (const m of members) {
      if (org.status & OrganizationModel.COLLAB_ALL_MEMBERS || (org.status & OrganizationModel.COLLAB_PRIMARY_CONTACT && m.status & UserModel.PRIMARY_ORG_CONTACT)) {
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
      type: ThreadEntryType.MESSAGE,
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
      .set({ flags: sql<number>`flags | ${ThreadEntry.ORIGINAL_MESSAGE}` })
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
      if (truthy(vars.staffId)) await autoAssignToStaff(ctx, rec, threadId, Number(vars.staffId), true, "Ticket Filter");
      if (truthy(vars.teamId)) await autoAssignToTeam(ctx, rec, threadId, Number(vars.teamId), !truthy(vars.staffId), "Ticket Filter");
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
