import "server-only";

import { SLA, Topic } from "@/lib/osticket/flags";
import { ObjectType } from "@/lib/osticket/object-types";

import { NOW } from "../../db";
import { phpStripTags } from "../../format/html";
import { isNumeric } from "../../php/values";
import { currentDates, currentTimezone } from "../forms/entry";
import {
  hasAnswerRow,
  hasData,
  isEditableTo,
  isPresentationOnly,
  isRequiredFor,
  isVisibleTo,
  parseField,
  parseFieldOrAnswer,
  plainLabel,
  validateField,
  type CleanValue,
  type FieldErrorCode,
  type FormSource,
} from "../forms/fields";
import { reindexTicket } from "../search/index-writer";
import { TicketPerm } from "../staff/staff";
import { currentTicketThreadId, ticketThread } from "../thread/ids";
import type { WriteContext } from "./context";
import { logThreadEvent, logTicketEvent } from "./events";
import { logNote, postNote } from "./post";
import { SQL_NOW, TicketRecord, phpLooseEquals, type TicketColumns } from "./record";
import { updateEstDueDate } from "./status";
import { checkStaffPerm, loadTicket } from "./ticket";
import { addMissingAnswers, newRepr, oldRepr, saveAnswer, sameAnswer, ticketForms, type Answer } from "./edit-answers";
import { cleanHtmlBody, phpAssocJson, RawJson, TICKET_SOURCE_KEYS, truncate, userDateToDb } from "./edit-values";

/**
 * Modifica del ticket da parte di un agente (area "ticketedit"):
 * - Ticket::update (form "Modifica" di scp/tickets.php a=update);
 * - Ticket::updateField (ajax.tickets.php editField: priorità, oggetto, campi singoli, topic, SLA,
 *   scadenza, origine);
 * - Ticket::changeOwner (scp/tickets.php do=changeuser).
 */

export type EditResult = { ok: true } | { error: string; detail?: string; fields?: Record<string, string[]> };

async function guard(ctx: WriteContext, ticketId: number, perm?: string): Promise<{ ok: true; rec: TicketRecord } | { error: string }> {
  const { tx, agent } = ctx;
  if (!agent) return { error: "denied" };
  const t = await loadTicket(ticketId, agent.id, tx);
  if (!t || !(await checkStaffPerm(t, agent, undefined, tx))) return { error: "not_found" };
  if (perm && !(await checkStaffPerm(t, agent, perm, tx))) return { error: "denied" };
  const rec = await TicketRecord.load(tx, ticketId, true);
  if (!rec) return { error: "not_found" };
  return { ok: true, rec };
}

interface TicketUpdateInput {
  ticketId: number;
  topicId: string;
  slaId: string;
  source?: string;
  /** scadenza come inserita dall'agente (vuota = nessuna) */
  duedate: string;
  /** nuovo proprietario (campo nascosto user_id del form) */
  userId?: string;
  note?: string;
  /** valori dei campi dei form dinamici per nome (o id) del campo, come $_POST */
  vars: FormSource;
  /** id delle form_entry da mantenere, nell'ordine ($vars['forms']); default: tutte */
  forms?: number[];
}

/**
 * Ticket::update (include/class.ticket.php:3675) dal form di modifica: validazione, topic, SLA,
 * origine, scadenza, proprietario, nota "Ticket Updated" (con avvisi), risposte dei form con cdata,
 * evento "edited" con le modifiche, riselezione dello SLA transitorio, scadenza stimata, `_search`.
 */
export async function updateTicket(ctx: WriteContext, input: TicketUpdateInput): Promise<EditResult> {
  const g = await guard(ctx, input.ticketId, TicketPerm.EDIT);
  if ("error" in g) return g;
  const { rec } = g;
  const { tx, cfg } = ctx;
  const errors: Record<string, string[]> = {};
  const err = (k: string, code: string) => (errors[k] = [...(errors[k] ?? []), code]);

  // Validator::process
  if (!isNumeric(input.topicId)) err("topicId", "invalid");
  if (input.slaId && !isNumeric(input.slaId)) err("slaId", "invalid");
  if (input.userId && !isNumeric(input.userId)) err("user_id", "invalid");
  let duedate: { db: string; past: boolean } | null = null;
  if (input.duedate) {
    duedate = userDateToDb(input.duedate, ctx.dbZone);
    if (!duedate) err("duedate", "invalid");
  }
  const note = cleanHtmlBody(input.note ?? "");

  const state = (await tx.selectFrom("ticket_status").select("state").where("id", "=", rec.get("status_id")).executeTakeFirst())?.state ?? "";
  if (input.duedate && !errors.duedate) {
    if (state === "closed") err("duedate", "closed");
    else if (duedate!.past) err("duedate", "past");
  }
  if (input.source !== undefined && !(TICKET_SOURCE_KEYS as readonly string[]).includes(input.source)) err("source", "invalid");
  const topic = isNumeric(input.topicId)
    ? await tx.selectFrom("help_topic").select(["topic_id", "flags"]).where("topic_id", "=", Number(input.topicId)).executeTakeFirst()
    : undefined;
  if (topic && !((topic.flags ?? 0) & Topic.ACTIVE)) err("topicId", "inactive");

  // Form dinamici: solo i campi memorizzabili, visibili e modificabili dall'agente. `parsed` è il valore
  // del widget (getChanges: assente → nullo), `clean` quello di getClean() che si valida e si salva
  // (assente → risposta attuale), nel fuso dell'agente ($cfg->getTimezone())
  const forms = await ticketForms(tx, cfg, rec.id);
  const keep = input.forms ?? forms.map((f) => f.entryId);
  const tz = await currentTimezone(ctx);
  const parsed = new Map<number, CleanValue>();
  const clean = new Map<number, CleanValue>();
  for (const form of forms) {
    if (!keep.includes(form.entryId)) continue;
    for (const a of form.answers) {
      const f = a.field;
      if (!hasAnswerRow(f)) continue;
      parsed.set(f.id, parseField(f, input.vars, tz));
      clean.set(f.id, parseFieldOrAnswer(f, input.vars, a.exists ? a : null, tz));
      if (!(isVisibleTo(f, "staff") && isEditableTo(f, "staff"))) continue;
      const codes: FieldErrorCode[] = await validateField(f, clean.get(f.id)!, isRequiredFor(f, "staff"), cfg);
      if (codes.length) errors[`field.${f.id}`] = codes;
    }
  }
  if (Object.keys(errors).length) return { error: "invalid", fields: errors };

  await addMissingAnswers(tx, forms);

  const before = { ...rec.row };
  const keepSLA = !phpLooseEquals(rec.get("sla_id"), input.slaId);
  rec.set("topic_id", input.topicId as never);
  rec.set("sla_id", input.slaId as never);
  rec.set("source", (input.source ?? null) as never);
  rec.set("duedate", duedate ? duedate.db : null);
  if (input.userId) rec.set("user_id", input.userId as never);
  if (duedate) rec.set("isoverdue", 0);

  // Modifiche nell'ordine di assegnazione (array dirty del PHP)
  const changes: [string, unknown][] = [];
  const newVals: Partial<Record<keyof TicketColumns, unknown>> = {
    topic_id: input.topicId,
    sla_id: input.slaId,
    source: input.source ?? null,
    duedate: duedate ? duedate.db : null,
  };
  if (input.userId) newVals.user_id = input.userId;
  for (const k of ["topic_id", "sla_id", "source", "duedate", "user_id"] as const) {
    if (!(k in newVals)) continue;
    if (!phpLooseEquals(before[k], newVals[k])) changes.push([k, [before[k], newVals[k]]]);
  }

  await rec.save();
  if (note) await logNote(ctx, rec.id, "Ticket Updated", note);

  // Risposte dei form: modifiche (getChanges) prima del salvataggio. DynamicFormEntry::getChanges non
  // filtra per visibilità: un campo che l'agente non vede o non può modificare risulta "cambiato" nel
  // valore nullo del widget (stranezza del PHP replicata), anche se saveAnswers non lo salva
  const fieldChanges: [string, unknown][] = [];
  for (const form of forms) {
    if (!keep.includes(form.entryId)) continue;
    for (const a of form.answers) {
      const f = a.field;
      if (!a.exists || !hasData(f) || isPresentationOnly(f) || !parsed.has(f.id)) continue;
      const n = newRepr(f, parsed.get(f.id)!);
      if (!sameAnswer(f, a, n)) fieldChanges.push([String(f.id), [oldRepr(f, a), n.repr]]);
    }
  }
  if (fieldChanges.length) changes.push(["fields", fieldChanges]);
  for (const form of forms) {
    const pos = keep.indexOf(form.entryId);
    if (pos < 0) {
      // Form rimosso: DynamicFormEntry::delete (riga dell'entry, poi le risposte)
      await tx.deleteFrom("form_entry").where("id", "=", form.entryId).execute();
      await tx.deleteFrom("form_entry_values").where("entry_id", "=", form.entryId).execute();
      continue;
    }
    if (form.sort !== pos) {
      await tx.updateTable("form_entry").set({ sort: pos, updated: NOW }).where("id", "=", form.entryId).execute();
    }
    for (const a of form.answers) {
      const f = a.field;
      if (!a.exists || !hasAnswerRow(f)) continue;
      if (!(isVisibleTo(f, "staff") && isEditableTo(f, "staff"))) continue;
      await saveAnswer(tx, rec.id, a, clean.get(f.id) ?? null);
    }
  }

  if (changes.length) {
    const threadId = await currentTicketThreadId(tx, rec.id);
    if (threadId) {
      const data = phpAssocJson(changes.map(([k, v]) => [k, k === "fields" ? new RawJson(phpAssocJson(v as [string, unknown][])) : v]));
      await logEditedRaw(ctx, rec, threadId, data);
    }
  }

  // Riselezione dello SLA se non è stato cambiato e quello attuale manca o è transitorio
  if (!keepSLA) {
    const sla = rec.get("sla_id") ? await tx.selectFrom("sla").select(["id", "flags"]).where("id", "=", rec.get("sla_id")).executeTakeFirst() : undefined;
    if (!sla || sla.flags & SLA.TRANSIENT) await selectSlaId(ctx, rec);
  }
  await rec.save();
  await updateEstDueDate(ctx, rec);
  // Signal model.updated → indice
  await reindexTicket(tx, rec.id, await currentDates(ctx));
  return { ok: true };
}

/** Evento "edited" con dati JSON già serializzati (ordine delle chiavi come il PHP). */
async function logEditedRaw(ctx: WriteContext, rec: TicketRecord, threadId: number, data: string | null): Promise<void> {
  const staffId = ctx.actor?.kind === "staff" && !rec.row.staff_id ? ctx.actor.id : rec.row.staff_id;
  await logThreadEvent(ctx.tx, {
    threadId,
    threadType: ObjectType.TICKET,
    state: "edited",
    data,
    actor: ctx.actor,
    staffId,
    teamId: rec.row.team_id,
    deptId: rec.row.dept_id,
    topicId: rec.row.topic_id,
  });
}

/** Ticket::selectSLAId(): SLA del reparto, poi del topic, poi quello predefinito; setSLAId salva. */
async function selectSlaId(ctx: WriteContext, rec: TicketRecord): Promise<number | false> {
  const { tx, cfg } = ctx;
  let slaId = 0;
  const dept = await tx.selectFrom("department").select("sla_id").where("id", "=", rec.get("dept_id")).executeTakeFirst();
  const topic = rec.get("topic_id")
    ? await tx.selectFrom("help_topic").select("sla_id").where("topic_id", "=", rec.get("topic_id")).executeTakeFirst()
    : undefined;
  if (dept?.sla_id) slaId = dept.sla_id;
  else if (topic?.sla_id) slaId = topic.sla_id;
  else slaId = cfg.int("default_sla_id");
  if (!slaId) return false;
  if (phpLooseEquals(slaId, rec.get("sla_id"))) return slaId;
  const exists = await tx.selectFrom("sla").select("id").where("id", "=", slaId).executeTakeFirst();
  if (!exists) return false;
  rec.set("sla_id", slaId);
  await rec.save();
  return slaId;
}

interface FieldUpdateInput {
  ticketId: number;
  field: string;
  /** valori del campo come $_POST (per nome del campo, o topic_id / sla_id / source / duedate) */
  vars: FormSource;
  comments?: string;
}

/**
 * ajax.tickets.php editField + Ticket::updateField (include/class.ticket.php:3809).
 * - campi dei form (priorità, oggetto, campi personalizzati): risposta aggiornata con cdata, evento
 *   "edited" con `{"0":vecchio,"1":nuovo,"fields":{"<id>":[vecchio,nuovo]}}` (dati così come li
 *   produce l'array_merge del PHP);
 * - topic, SLA, origine, scadenza: colonna del ticket, evento con `{"<colonna>":[vecchio,nuovo]}`;
 *   per SLA e scadenza poi la scadenza stimata.
 * Poi nota "<etichetta> updated" con i commenti (senza avvisi), `lastupdate = NOW()`, save.
 */
export async function updateTicketField(ctx: WriteContext, input: FieldUpdateInput): Promise<EditResult> {
  const g = await guard(ctx, input.ticketId, TicketPerm.EDIT);
  if ("error" in g) return g;
  const { rec } = g;
  const { tx, cfg } = ctx;
  const threadId = await currentTicketThreadId(tx, rec.id);

  let label = "";
  let changes: string | null = null;
  let updateDuedate = false;

  const special = ["topic", "sla", "source", "duedate"].includes(input.field);
  if (!special) {
    // Campo dei form del ticket: per id, o "priority" (Ticket::getPriorityField)
    const forms = await ticketForms(tx, cfg, rec.id);
    let answer: Answer | undefined;
    for (const form of forms) {
      for (const a of form.answers) {
        if (input.field === "priority" ? a.field.name === "priority" && a.exists : String(a.field.id) === input.field) answer ??= a;
      }
    }
    if (!answer) return { error: "no_such_field" };
    const f = answer.field;
    label = plainLabel(f.label);
    const tz = await currentTimezone(ctx);
    // FormField::save salva getChanges(): il valore del widget (assente → nullo)
    const clean = parseField(f, input.vars, tz);
    // SimpleForm::isValid() del form di modifica (campo obbligatorio per l'agente, validatori) su
    // getClean(): un campo assente vale la risposta attuale
    const codes = await validateField(f, parseFieldOrAnswer(f, input.vars, answer.exists ? answer : null, tz), isRequiredFor(f, "staff"), cfg);
    if (codes.length) return { error: "invalid", fields: { [`field.${f.id}`]: codes } };
    const n = newRepr(f, clean);
    if (!answer.exists || sameAnswer(f, answer, n)) return { error: "already_set" };
    if (!(isVisibleTo(f, "staff") && isEditableTo(f, "staff"))) return { error: "not_editable" };
    let prevRepr = oldRepr(f, answer);
    let newR = n.repr;
    await saveAnswer(tx, rec.id, answer, clean);
    // TextareaField: tag rimossi e testo troncato a 200 caratteri nei dati dell'evento
    if (f.type === "memo") {
      prevRepr = truncate(phpStripTags(String(prevRepr ?? "")), 200);
      newR = truncate(phpStripTags(String(newR ?? "")), 200);
    }
    changes = phpAssocJson([
      ["0", prevRepr],
      ["1", newR],
      ["fields", new RawJson(phpAssocJson([[String(f.id), [prevRepr, newR]]]))],
    ]);
    await rec.save();
  } else {
    const before = { ...rec.row };
    let col: keyof TicketColumns;
    let val: string | number | null;
    switch (input.field) {
      case "topic": {
        label = "Help Topic";
        col = "topic_id";
        const raw = String(input.vars.topic_id ?? "");
        if (phpLooseEquals(raw, rec.get("topic_id"))) return { error: "already_set" };
        // TopicField: topic attivi più quello attuale (Topic::getHelpTopics con whitelist)
        const t = raw ? await tx.selectFrom("help_topic").select(["topic_id", "flags"]).where("topic_id", "=", Number(raw)).executeTakeFirst() : undefined;
        if (!t || (!((t.flags ?? 0) & Topic.ACTIVE) && t.topic_id !== rec.get("topic_id"))) return { error: "invalid", fields: { topic_id: ["invalid"] } };
        val = t.topic_id;
        break;
      }
      case "sla": {
        label = "SLA Plan";
        col = "sla_id";
        const raw = String(input.vars.sla_id ?? "");
        if (phpLooseEquals(raw, rec.get("sla_id"))) return { error: "already_set" };
        // SLAField: un valore fuori dalle scelte non cambia lo SLA (il PHP registra comunque un evento vuoto)
        const s = raw ? await tx.selectFrom("sla").select(["id", "flags"]).where("id", "=", Number(raw)).executeTakeFirst() : undefined;
        val = s && s.flags & SLA.ACTIVE ? s.id : rec.get("sla_id");
        break;
      }
      case "source": {
        label = "Ticket Source";
        col = "source";
        const raw = String(input.vars.source ?? "");
        if (phpLooseEquals(raw, rec.get("source"))) return { error: "already_set" };
        if (!(TICKET_SOURCE_KEYS as readonly string[]).includes(raw)) return { error: "invalid", fields: { source: ["invalid"] } };
        val = raw;
        break;
      }
      default: {
        label = "Due Date";
        col = "duedate";
        const raw = String(input.vars.duedate ?? "");
        if (!raw) val = null;
        else {
          const d = userDateToDb(raw, ctx.dbZone);
          if (!d) return { error: "invalid", fields: { duedate: ["invalid"] } };
          if (d.past) return { error: "invalid", fields: { duedate: ["past"] } };
          val = d.db;
        }
      }
    }
    rec.set(col, val as never);
    const pairs: [string, unknown][] = [];
    if (!phpLooseEquals(before[col], val)) {
      pairs.push([col, [before[col], val]]);
      if (col === "sla_id" || col === "duedate") updateDuedate = true;
    }
    changes = pairs.length ? phpAssocJson(pairs) : null;
    await rec.save();
  }

  // logEvent('edited', $changes): con un array vuoto i dati restano NULL
  if (threadId) await logEditedRaw(ctx, rec, threadId, changes);

  const comments = cleanHtmlBody(input.comments ?? "");
  if (comments) await postNote(ctx, { ticketId: rec.id, note: comments, title: `${label} updated`, alert: false });

  rec.set("lastupdate", SQL_NOW as never);
  if (updateDuedate) await updateEstDueDate(ctx, rec);
  await rec.save();
  await reindexTicket(tx, rec.id, await currentDates(ctx));
  return { ok: true };
}

/**
 * Ticket::changeOwner (scp/tickets.php do=changeuser): nuovo proprietario, rimozione del suo
 * eventuale ruolo di collaboratore, evento "edited" `{"owner":id,"fields":{"Ticket Owner":"Nome"}}`.
 */
export async function changeTicketOwner(ctx: WriteContext, input: { ticketId: number; userId: number }): Promise<EditResult> {
  const g = await guard(ctx, input.ticketId, TicketPerm.EDIT);
  if ("error" in g) return g;
  const { rec } = g;
  const { tx } = ctx;
  const user = input.userId ? await tx.selectFrom("user").select(["id", "name"]).where("id", "=", input.userId).executeTakeFirst() : undefined;
  if (!user) return { error: "unknown_user" };
  if (user.id === rec.get("user_id")) return { error: "already_owner" };
  rec.set("user_id", user.id);
  await rec.save();
  const thread = await ticketThread(tx, rec.id);
  if (thread) {
    await tx.deleteFrom("thread_collaborator").where("user_id", "=", user.id).where("thread_id", "=", thread.id).execute();
    await logTicketEvent(tx, rec.row, thread.id, ctx.actor, "edited", { owner: user.id, fields: { "Ticket Owner": user.name } });
  }
  return { ok: true };
}
