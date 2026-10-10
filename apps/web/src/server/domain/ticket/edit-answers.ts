import "server-only";

import { DynamicFormField } from "@/lib/osticket/flags";
import { FormType } from "@/lib/osticket/object-types";

import type { ConfigNamespace } from "../../config/config";
import type { DbOrTx } from "../../db";
import { upsertCdata } from "../forms/cdata";
import {
  answerChangeValue,
  fieldSearchKeys,
  fieldToDatabase,
  hasAnswerRow,
  hasFlag,
  type CleanValue,
  type FieldDef,
} from "../forms/fields";
import { loadFormDef } from "../forms/load";
import { phpLooseEquals } from "./record";

/**
 * Risposte dei form del ticket nella modifica da parte di un agente: lettura (DynamicFormEntry::forTicket),
 * risposte mancanti (addMissingFields), salvataggio con cdata (DynamicFormEntryAnswer::save) e
 * rappresentazione delle modifiche per l'evento "edited" (getChanges).
 */

/** Risposta di un campo dei form del ticket (form_entry_values) con la definizione del campo. */
export interface Answer {
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

/** Risposta attuale nei dati dell'evento "edited" (getChanges: to_database(to_php($value))). */
export function oldRepr(f: FieldDef, a: Answer): unknown {
  return f.type === "datetime" ? answerChangeValue(f, a.value) : dbRepr(f, a.value, a.valueId);
}

export function newRepr(f: FieldDef, clean: CleanValue): { value: string | null; valueId: number | null; repr: unknown } {
  const db = fieldToDatabase(f, clean);
  return { ...db, repr: dbRepr(f, db.value, db.valueId) };
}

export function sameAnswer(f: FieldDef, a: Answer, n: { value: string | null; valueId: number | null }): boolean {
  if (f.type === "priority" || f.type === "department") return phpLooseEquals(a.value, n.value) && phpLooseEquals(a.valueId, n.valueId);
  return phpLooseEquals(a.value, n.value);
}

/** Form del ticket (DynamicFormEntry::forTicket) con le risposte esistenti. */
export async function ticketForms(tx: DbOrTx, cfg: ConfigNamespace, ticketId: number) {
  const entries = await tx
    .selectFrom("form_entry")
    .select(["id", "form_id", "sort"])
    .where("object_type", "=", FormType.TICKET)
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

/** DynamicFormEntryAnswer::save: aggiorna value/value_id se cambiano, poi la cdata. */
export async function saveAnswer(tx: DbOrTx, ticketId: number, a: Answer, clean: CleanValue): Promise<boolean> {
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
  await upsertCdata(tx, "T", ticketId, a.field, fieldSearchKeys(a.field, clean));
  return true;
}

/**
 * DynamicFormEntry::addMissingFields (scp/tickets.php a=edit, alla visualizzazione del form): risposte
 * NULL per i campi aggiunti al form dopo la creazione dell'entry. Il PHP lo fa all'apertura della
 * pagina di modifica; qui avviene al salvataggio, prima di calcolare le modifiche (stesso risultato).
 */
export async function addMissingAnswers(tx: DbOrTx, forms: Awaited<ReturnType<typeof ticketForms>>): Promise<void> {
  for (const form of forms) {
    for (const a of form.answers) {
      const f = a.field;
      if (a.exists || !hasFlag(f, DynamicFormField.ENABLED) || !hasAnswerRow(f)) continue;
      await tx.insertInto("form_entry_values").values({ entry_id: a.entryId, field_id: f.id, value: null, value_id: null }).execute();
      a.exists = true;
    }
  }
}
