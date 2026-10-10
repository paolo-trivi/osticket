import "server-only";

import { FormType } from "@/lib/osticket/object-types";

import type { ConfigNamespace } from "../../config/config";
import { db, type DbOrTx } from "../../db";
import { phpLooseEquals } from "../../php/values";
import { upsertCdata } from "../forms/cdata";
import { currentTimezone } from "../forms/entry";
import {
  answerChangeValue,
  cleanFromDb,
  fieldSearchKeys,
  fieldToDatabase,
  hasData,
  isEditableTo,
  isPresentationOnly,
  isRequiredFor,
  isStorable,
  isVisibleTo,
  parseField,
  parseFieldOrAnswer,
  validateField,
  type CleanValue,
  type FieldDef,
  type FieldErrorCode,
} from "../forms/fields";
import { loadFormDef } from "../forms/load";
import { ticketThreadId } from "../thread/ids";
import type { WriteContext } from "../ticket/context";
import { logTicketEvent, type Actor } from "../ticket/events";
import { TicketRecord } from "../ticket/record";
import type { ClientIdentity } from "./identity";
import { clientCanAccess } from "./tickets";

/** Modifica dei campi del ticket da parte del proprietario (tickets.php a=edit). */

/** Form dei campi modificabili dal cliente (tickets.php a=edit) con i valori attuali */
export async function clientEditForms(cfg: ConfigNamespace, ticketId: number, executor: DbOrTx = db()) {
  const entries = await executor.selectFrom("form_entry").select(["id", "form_id"]).where("object_type", "=", FormType.TICKET).where("object_id", "=", ticketId).orderBy("sort").orderBy("id").execute();
  const out: { entryId: number; title: string; fields: FieldDef[]; values: Map<number, CleanValue> }[] = [];
  for (const e of entries) {
    const def = await loadFormDef(executor, cfg, { id: e.form_id }, "client");
    if (!def) continue;
    const vals = await executor.selectFrom("form_entry_values").select(["field_id", "value", "value_id"]).where("entry_id", "=", e.id).execute();
    const values = new Map<number, CleanValue>();
    for (const v of vals) {
      const f = def.fields.find((x) => x.id === v.field_id);
      if (f) values.set(f.id, cleanFromDb(f, v.value, v.value_id));
    }
    out.push({ entryId: e.id, title: def.title, fields: def.fields.filter((f) => isStorable(f)), values });
  }
  return out;
}

export type ClientEditResult = { ok: true; changes: number } | { error: "access" } | { error: "invalid"; fields: Record<number, FieldErrorCode[]> };

/**
 * tickets.php POST a=edit: solo il proprietario; validazione isValidForClient(true) dei campi
 * memorizzabili, risposte salvate per i campi visibili e modificabili dai clienti (cdata), evento
 * "edited" `{"fields":{"<id>":[vecchio,nuovo]}}` con l'utente come autore. Il ticket non viene
 * salvato (nessun updated, nessuna reindicizzazione di `_search`: come il PHP). Date nel fuso del
 * cliente ($cfg->getTimezone()).
 */
export async function editTicketAsClient(ctx: WriteContext, client: ClientIdentity, ticketId: number, vars: Record<string, unknown>): Promise<ClientEditResult> {
  const { tx, cfg, actor } = ctx;
  const rec = await TicketRecord.load(tx, ticketId, true);
  if (!rec || !(await clientCanAccess(client, ticketId, tx)) || rec.get("user_id") !== client.id) return { error: "access" };
  const forms = await clientEditForms(cfg, ticketId, tx);
  const tz = await currentTimezone(ctx);
  const errors: Record<number, FieldErrorCode[]> = {};
  // `parsed`: valore del widget (getChanges: assente → nullo); `clean`: getClean(), validato e salvato
  // (assente → risposta attuale)
  const parsed = new Map<number, CleanValue>();
  const clean = new Map<number, CleanValue>();
  const rowsOf = new Map<number, { field_id: number; value: string | null; value_id: number | null }[]>();
  for (const form of forms) {
    const rows = await tx.selectFrom("form_entry_values").select(["field_id", "value", "value_id"]).where("entry_id", "=", form.entryId).execute();
    rowsOf.set(form.entryId, rows);
    for (const f of form.fields) {
      if (!hasData(f) || isPresentationOnly(f)) continue;
      const cur = rows.find((r) => r.field_id === f.id);
      parsed.set(f.id, parseField(f, vars, tz));
      clean.set(f.id, parseFieldOrAnswer(f, vars, cur ? { value: cur.value, valueId: cur.value_id } : null, tz));
      if (!isEditableTo(f, "client")) continue;
      const codes = await validateField(f, clean.get(f.id)!, isRequiredFor(f, "client"), cfg);
      if (codes.length) errors[f.id] = codes;
    }
  }
  if (Object.keys(errors).length) return { error: "invalid", fields: errors };

  // DynamicFormEntry::getChanges su tutti i campi memorizzabili, anche quelli non visibili o non
  // modificabili dal cliente (assenti dal POST → nuovo valore nullo): stranezza del PHP replicata
  // nell'evento; saveAnswers salva getClean() dei soli campi visibili e modificabili dai clienti.
  const changes: Record<string, [unknown, unknown]> = {};
  const idType = (f: FieldDef) => f.type === "priority" || f.type === "department";
  const same = (f: FieldDef, cur: { value: string | null; value_id: number | null }, n: { value: string | null; valueId: number | null }) =>
    phpLooseEquals(cur.value, n.value) && (!idType(f) || phpLooseEquals(cur.value_id, n.valueId));
  for (const form of forms) {
    const rows = rowsOf.get(form.entryId) ?? [];
    for (const f of form.fields) {
      if (!hasData(f) || isPresentationOnly(f)) continue;
      const cur = rows.find((r) => r.field_id === f.id);
      if (!cur) continue;
      const n = fieldToDatabase(f, parsed.get(f.id) ?? null);
      // [vecchio, nuovo] nel formato to_database
      if (!same(f, cur, n) && !(String(f.id) in changes)) {
        const repr = (v: string | null, id: number | null) => (idType(f) ? (v === null && id === null ? null : [v, id]) : v);
        changes[String(f.id)] = [f.type === "datetime" ? answerChangeValue(f, cur.value) : repr(cur.value, cur.value_id), repr(n.value, n.valueId)];
      }
      if (!(isVisibleTo(f, "client") && isEditableTo(f, "client"))) continue;
      const value = clean.get(f.id) ?? null;
      const s = fieldToDatabase(f, value);
      if (same(f, cur, s)) continue;
      const set: Record<string, unknown> = { value: s.value };
      if (idType(f)) set.value_id = s.valueId;
      await tx.updateTable("form_entry_values").set(set as never).where("entry_id", "=", form.entryId).where("field_id", "=", f.id).execute();
      await upsertCdata(tx, "T", ticketId, f, fieldSearchKeys(f, value));
    }
  }
  const n = Object.keys(changes).length;
  if (n) {
    const thId = await ticketThreadId(tx, ticketId);
    // $ticket->logEvent('edited', ['fields' => $changes], User::lookup($thisclient->getId()))
    const who: Actor = actor?.kind === "user" ? { ...actor } : actor;
    await logTicketEvent(tx, rec.row, thId, actor, "edited", { fields: changes }, who ?? undefined);
  }
  return { ok: true, changes: n };
}
