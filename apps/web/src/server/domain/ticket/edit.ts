import "server-only";

import { sql } from "kysely";
import { DateTime } from "luxon";

import type { ConfigNamespace } from "../../config/config";
import { NOW, table, type DbOrTx } from "../../db";
import { phpJsonEncode } from "../../format/php-json";
import { phpStripTags } from "../../format/html";
import { editorSpacing, phpTrim, sanitizeText } from "../../format/text";
import {
  fieldSearchKeys,
  fieldToDatabase,
  hasData,
  isEditableTo,
  isPresentationOnly,
  isRequiredFor,
  isStorable,
  isVisibleTo,
  parseField,
  phpParseDateTime,
  plainLabel,
  validateField,
  type CleanValue,
  type FieldDef,
  type FieldErrorCode,
  type FormSource,
} from "../forms/fields";
import { loadFormDef } from "../forms/load";
import { reindexTicket } from "../search/index-writer";
import { TicketPerm } from "../staff/staff";
import type { WriteContext } from "./context";
import { logThreadEvent, logTicketEvent } from "./events";
import { ticketThread } from "./merge-flags";
import { logNote, postNote } from "./post";
import { SQL_NOW, TicketRecord, phpLooseEquals, type TicketColumns } from "./record";
import { updateEstDueDate } from "./status";
import { checkStaffPerm, loadTicket } from "./ticket";

/**
 * Modifica del ticket da parte di un agente (area "ticketedit"):
 * - Ticket::update (form "Modifica" di scp/tickets.php a=update);
 * - Ticket::updateField (ajax.tickets.php editField: priorità, oggetto, campi singoli, topic, SLA,
 *   scadenza, origine);
 * - Ticket::changeOwner (scp/tickets.php do=changeuser).
 */

export type EditResult = { ok: true } | { error: string; detail?: string; fields?: Record<string, string[]> };

/** Ticket::getSources() */
export const TICKET_SOURCE_KEYS = ["Phone", "Email", "Web", "API", "Other"] as const;

/** Sla::FLAG_* */
const SLA_ACTIVE = 0x0001;
const SLA_TRANSIENT = 0x0008;
/** Topic::FLAG_ACTIVE */
const TOPIC_ACTIVE = 0x0002;

/** Frammento JSON già serializzato da inserire così com'è in phpAssocJson. */
class RawJson {
  constructor(readonly json: string) {}
}

/** JSON di un array associativo PHP con l'ordine delle chiavi preservato (anche numeriche). */
function phpAssocJson(pairs: [string, unknown][]): string {
  return `{${pairs.map(([k, v]) => `${phpJsonEncode(String(k))}:${v instanceof RawJson ? v.json : phpJsonEncode(v)}`).join(",")}}`;
}

/** ThreadEntryBody::clean per l'HTML di un agente: '' se il corpo è vuoto (solo spazi, <, >, b, r, /). */
function cleanHtmlBody(body: string): string {
  const b = phpTrim(body ?? "", " <>br/\t\n\r") ? body : "";
  return b ? sanitizeText(editorSpacing(b)) : "";
}

const isNumeric = (v: unknown) => typeof v === "number" || (typeof v === "string" && /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(v));

/**
 * Data inserita dall'agente → datetime del DB come Ticket::update / updateField: la stringa è
 * interpretata da Format::parseDateTime nel fuso predefinito del PHP (UTC, anche se l'agente ha un
 * altro fuso: stranezza del PHP replicata) e convertita nel fuso del DB.
 */
function userDateToDb(input: string, dbZone: string): { db: string; past: boolean } | null {
  const dt = phpParseDateTime(input);
  if (!dt) return null;
  return { db: dt.setZone(dbZone).toFormat("yyyy-MM-dd HH:mm:ss"), past: dt.toMillis() <= Date.now() };
}

/** Risposta di un campo dei form del ticket (form_entry_values) con la definizione del campo. */
interface Answer {
  entryId: number;
  field: FieldDef;
  value: string | null;
  valueId: number | null;
  exists: boolean;
}

/** Rappresentazione to_database di un valore per i dati dell'evento "edited". */
function dbRepr(f: FieldDef, value: string | null, valueId: number | null): unknown {
  if (f.type === "priority" || f.type === "department") return value === null && valueId === null ? null : [value, valueId];
  return value;
}

function newRepr(f: FieldDef, clean: CleanValue): { value: string | null; valueId: number | null; repr: unknown } {
  const db = fieldToDatabase(f, clean);
  return { ...db, repr: dbRepr(f, db.value, db.valueId) };
}

function sameAnswer(f: FieldDef, a: Answer, n: { value: string | null; valueId: number | null }): boolean {
  if (f.type === "priority" || f.type === "department") return phpLooseEquals(a.value, n.value) && phpLooseEquals(a.valueId, n.valueId);
  return phpLooseEquals(a.value, n.value);
}

/** Form del ticket (DynamicFormEntry::forTicket) con le risposte esistenti. */
async function ticketForms(tx: DbOrTx, cfg: ConfigNamespace, ticketId: number) {
  const entries = await tx
    .selectFrom("form_entry")
    .select(["id", "form_id", "sort"])
    .where("object_type", "=", "T")
    .where("object_id", "=", ticketId)
    .orderBy("sort")
    .orderBy("id")
    .execute();
  const out: { entryId: number; sort: number; fields: FieldDef[]; answers: Answer[] }[] = [];
  for (const e of entries) {
    const def = await loadFormDef(tx, cfg, { id: e.form_id }, "staff");
    if (!def) continue;
    const values = await tx.selectFrom("form_entry_values").select(["field_id", "value", "value_id"]).where("entry_id", "=", e.id).execute();
    const byField = new Map(values.map((v) => [v.field_id, v]));
    const answers: Answer[] = [];
    for (const f of def.fields) {
      const v = byField.get(f.id);
      answers.push({ entryId: e.id, field: f, value: v?.value ?? null, valueId: v?.value_id ?? null, exists: !!v });
    }
    out.push({ entryId: e.id, sort: e.sort, fields: def.fields, answers });
  }
  return out;
}

/** Upsert della colonna *__cdata del campo (DynamicForm::updateDynamicDataView, Signal model.updated). */
async function updateCdata(tx: DbOrTx, ticketId: number, f: FieldDef, clean: CleanValue): Promise<void> {
  const col = f.name || `field_${f.id}`;
  const res = await sql<Record<string, unknown>>`SHOW COLUMNS FROM ${table("ticket__cdata")}`.execute(tx).catch(() => null);
  if (!res || !res.rows.some((r) => String(r.Field) === col)) {
    // il PHP esegue comunque la INSERT: se la colonna non esiste la query fallisce senza effetti
    return;
  }
  const keys = fieldSearchKeys(f, clean);
  await sql`INSERT INTO ${table("ticket__cdata")} SET ${sql.ref(col)} = ${keys}, ticket_id = ${ticketId}
    ON DUPLICATE KEY UPDATE ${sql.ref(col)} = ${keys}`.execute(tx);
}

/** DynamicFormEntryAnswer::save: aggiorna value/value_id se cambiano, poi la cdata. */
async function saveAnswer(tx: DbOrTx, ticketId: number, a: Answer, clean: CleanValue): Promise<boolean> {
  const n = fieldToDatabase(a.field, clean);
  const set: Record<string, unknown> = {};
  if (!phpLooseEquals(a.value, n.value)) set.value = n.value;
  if ((a.field.type === "priority" || a.field.type === "department") && !phpLooseEquals(a.valueId, n.valueId)) set.value_id = n.valueId;
  if (!Object.keys(set).length) return false;
  await tx
    .updateTable("form_entry_values")
    .set(set as never)
    .where("entry_id", "=", a.entryId)
    .where("field_id", "=", a.field.id)
    .execute();
  a.value = n.value;
  if ("value_id" in set) a.valueId = n.valueId;
  await updateCdata(tx, ticketId, a.field, clean);
  return true;
}

/**
 * DynamicFormEntry::addMissingFields (scp/tickets.php a=edit, alla visualizzazione del form): risposte
 * NULL per i campi aggiunti al form dopo la creazione dell'entry. Il PHP lo fa all'apertura della
 * pagina di modifica; qui avviene al salvataggio, prima di calcolare le modifiche (stesso risultato).
 */
async function addMissingAnswers(tx: DbOrTx, forms: Awaited<ReturnType<typeof ticketForms>>): Promise<void> {
  for (const form of forms) {
    for (const a of form.answers) {
      const f = a.field;
      if (a.exists || !(f.flags & 0x1) || isPresentationOnly(f) || !hasData(f) || !isStorable(f)) continue;
      await tx.insertInto("form_entry_values").values({ entry_id: a.entryId, field_id: f.id, value: null, value_id: null }).execute();
      a.exists = true;
    }
  }
}

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

async function threadIdOf(tx: DbOrTx, ticketId: number): Promise<number> {
  return (await ticketThread(tx, ticketId))?.id ?? 0;
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
  if (topic && !((topic.flags ?? 0) & TOPIC_ACTIVE)) err("topicId", "inactive");

  // Form dinamici: solo i campi memorizzabili, visibili e modificabili dall'agente
  const forms = await ticketForms(tx, cfg, rec.id);
  const keep = input.forms ?? forms.map((f) => f.entryId);
  const parsed = new Map<number, CleanValue>();
  for (const form of forms) {
    if (!keep.includes(form.entryId)) continue;
    for (const f of form.fields) {
      if (!hasData(f) || !isStorable(f) || isPresentationOnly(f)) continue;
      const clean = parseField(f, input.vars, cfg.str("default_timezone") || "UTC");
      parsed.set(f.id, clean);
      if (!(isVisibleTo(f, "staff") && isEditableTo(f, "staff"))) continue;
      const codes: FieldErrorCode[] = await validateField(f, clean, isRequiredFor(f, "staff"), cfg);
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

  // Risposte dei form: modifiche (getChanges) prima del salvataggio
  const fieldChanges: [string, unknown][] = [];
  for (const form of forms) {
    if (!keep.includes(form.entryId)) continue;
    for (const a of form.answers) {
      const f = a.field;
      if (!a.exists || !hasData(f) || isPresentationOnly(f) || !parsed.has(f.id)) continue;
      if (!(isVisibleTo(f, "staff") && isEditableTo(f, "staff"))) continue;
      const n = newRepr(f, parsed.get(f.id)!);
      if (!sameAnswer(f, a, n)) fieldChanges.push([String(f.id), [dbRepr(f, a.value, a.valueId), n.repr]]);
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
      if (!a.exists || !hasData(f) || !isStorable(f) || isPresentationOnly(f)) continue;
      if (!(isVisibleTo(f, "staff") && isEditableTo(f, "staff"))) continue;
      await saveAnswer(tx, rec.id, a, parsed.get(f.id) ?? null);
    }
  }

  if (changes.length) {
    const threadId = await threadIdOf(tx, rec.id);
    if (threadId) {
      const data = phpAssocJson(changes.map(([k, v]) => [k, k === "fields" ? new RawJson(phpAssocJson(v as [string, unknown][])) : v]));
      await logEditedRaw(ctx, rec, threadId, data);
    }
  }

  // Riselezione dello SLA se non è stato cambiato e quello attuale manca o è transitorio
  if (!keepSLA) {
    const sla = rec.get("sla_id") ? await tx.selectFrom("sla").select(["id", "flags"]).where("id", "=", rec.get("sla_id")).executeTakeFirst() : undefined;
    if (!sla || sla.flags & SLA_TRANSIENT) await selectSlaId(ctx, rec);
  }
  await rec.save();
  await updateEstDueDate(ctx, rec);
  // Signal model.updated → indice
  await reindexTicket(tx, rec.id);
  return { ok: true };
}

/** Evento "edited" con dati JSON già serializzati (ordine delle chiavi come il PHP). */
async function logEditedRaw(ctx: WriteContext, rec: TicketRecord, threadId: number, data: string | null): Promise<void> {
  const staffId = ctx.actor?.kind === "staff" && !rec.row.staff_id ? ctx.actor.id : rec.row.staff_id;
  await logThreadEvent(ctx.tx, {
    threadId,
    threadType: "T",
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
  const threadId = await threadIdOf(tx, rec.id);

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
    const clean = parseField(f, input.vars, cfg.str("default_timezone") || "UTC");
    // SimpleForm::isValid() del form di modifica (campo obbligatorio per l'agente, validatori)
    const codes = await validateField(f, clean, isRequiredFor(f, "staff"), cfg);
    if (codes.length) return { error: "invalid", fields: { [`field.${f.id}`]: codes } };
    const n = newRepr(f, clean);
    if (!answer.exists || sameAnswer(f, answer, n)) return { error: "already_set" };
    if (!(isVisibleTo(f, "staff") && isEditableTo(f, "staff"))) return { error: "not_editable" };
    let oldRepr = dbRepr(f, answer.value, answer.valueId);
    let newR = n.repr;
    await saveAnswer(tx, rec.id, answer, clean);
    // TextareaField: tag rimossi e testo troncato a 200 caratteri nei dati dell'evento
    if (f.type === "memo") {
      oldRepr = truncate(phpStripTags(String(oldRepr ?? "")), 200);
      newR = truncate(phpStripTags(String(newR ?? "")), 200);
    }
    changes = phpAssocJson([
      ["0", oldRepr],
      ["1", newR],
      ["fields", new RawJson(phpAssocJson([[String(f.id), [oldRepr, newR]]]))],
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
        if (!t || (!((t.flags ?? 0) & TOPIC_ACTIVE) && t.topic_id !== rec.get("topic_id"))) return { error: "invalid", fields: { topic_id: ["invalid"] } };
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
        val = s && s.flags & SLA_ACTIVE ? s.id : rec.get("sla_id");
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
  await reindexTicket(tx, rec.id);
  return { ok: true };
}

/** Format::truncate($text, $len) senza parola spezzata: come il PHP, taglia e aggiunge "..." */
function truncate(text: string, len: number): string {
  if (text.length <= len) return text;
  const cut = text.slice(0, len);
  const sp = cut.lastIndexOf(" ");
  return `${sp > 0 ? cut.slice(0, sp) : cut}...`;
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

/** Data/ora del DB per il campo "scadenza" del form (datetime-local, interpretato come il PHP: UTC). */
export function dbDateToInput(value: string | null, dbZone: string): string {
  if (!value || value.startsWith("0000")) return "";
  const dt = DateTime.fromSQL(value, { zone: dbZone });
  return dt.isValid ? dt.setZone("UTC").toFormat("yyyy-MM-dd'T'HH:mm") : "";
}
