import "server-only";

import { sql } from "kysely";

import type { ConfigNamespace } from "../../config/config";
import { NOW, table, type DbOrTx } from "../../db";
import {
  fieldSearchKeys,
  fieldSearchable,
  fieldToDatabase,
  fieldToString,
  hasData,
  isPresentationOnly,
  isStorable,
  parseField,
  validateField,
  type CleanValue,
  type FieldDef,
  type FieldErrorCode,
  type FormSource,
} from "./fields";
import type { FormDef } from "./load";

/**
 * Istanza compilata di un form dinamico (DynamicFormEntry non ancora salvata): valori puliti dei
 * campi dalla sorgente, validazione per contesto, salvataggio in form_entry / form_entry_values e
 * aggiornamento della tabella materializzata *__cdata (DynamicForm::updateDynamicDataView).
 */
export class FormInstance {
  readonly values = new Map<number, CleanValue>();
  /** valori impostati dal codice (setAnswer) che prevalgono sulla sorgente solo se questa è vuota */
  private readonly fallbacks = new Map<number, CleanValue>();

  constructor(
    readonly def: FormDef,
    readonly source: FormSource,
    public sort = 1,
    public extra: string | null = null,
  ) {
    for (const f of def.fields) if (hasData(f)) this.values.set(f.id, parseField(f, source));
  }

  get fields(): FieldDef[] {
    return this.def.fields;
  }

  field(name: string): FieldDef | undefined {
    return this.def.fields.find((f) => f.name.toLowerCase() === name.toLowerCase());
  }

  get(name: string): CleanValue {
    const f = this.field(name);
    return f ? (this.values.get(f.id) ?? null) : null;
  }

  /** DynamicFormEntry::setAnswer: il valore della sorgente (input dell'utente) resta prioritario. */
  setAnswer(name: string, value: CleanValue): void {
    const f = this.field(name);
    if (!f || !isStorable(f)) return;
    this.fallbacks.set(f.id, value);
  }

  /** Valore effettivo che verrà salvato */
  effective(f: FieldDef): CleanValue {
    const v = this.values.get(f.id) ?? null;
    if (v !== null && v !== false) return v;
    return this.fallbacks.has(f.id) ? this.fallbacks.get(f.id)! : v;
  }

  /** Imposta direttamente un valore (es. oggetto vuoto sostituito dal nome del topic) */
  setValue(name: string, value: CleanValue): void {
    const f = this.field(name);
    if (f) this.values.set(f.id, value);
  }

  /**
   * Form::isValid($filter): errori dei soli campi per cui `include(f)` è vero; `required` per
   * agente o cliente come DynamicFormField::getField(). I campi disattivati dal topic non partecipano.
   */
  async validate(include: (f: FieldDef) => boolean, requiredFor: (f: FieldDef) => boolean, cfg: ConfigNamespace): Promise<Record<number, FieldErrorCode[]>> {
    const errors: Record<number, FieldErrorCode[]> = {};
    for (const f of this.def.fields) {
      if (f.disabled || !hasData(f)) continue;
      const errs = await validateField(f, this.values.get(f.id) ?? null, requiredFor(f), cfg);
      if (errs.length && include(f)) errors[f.id] = errs;
    }
    return errors;
  }

  /** DynamicFormEntry::getFilterData: `field.<id>` → testo */
  filterData(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const f of this.def.fields) {
      if (!hasData(f)) continue;
      const v = isPresentationOnly(f) ? (this.source.message as string | undefined) ?? "" : fieldToString(f, this.effective(f));
      if (v) out[`field.${f.id}`] = v;
    }
    return out;
  }

  /** Testi indicizzabili delle risposte (SearchBackend per User/Organization) */
  searchables(skip: string[] = []): string[] {
    const out: string[] = [];
    for (const f of this.def.fields) {
      if (!hasData(f) || !isStorable(f) || isPresentationOnly(f) || skip.includes(f.name)) continue;
      const v = fieldSearchable(f, this.effective(f));
      if (v) out.push(v);
    }
    return out;
  }
}

const CDATA: Record<string, { table: string; key: string }> = {
  T: { table: "ticket__cdata", key: "ticket_id" },
  A: { table: "task__cdata", key: "task_id" },
  U: { table: "user__cdata", key: "user_id" },
  O: { table: "organization__cdata", key: "org_id" },
};

async function cdataColumns(executor: DbOrTx, tableName: string): Promise<Set<string> | null> {
  const res = await sql<Record<string, unknown>>`SHOW COLUMNS FROM ${table(tableName as `${string}__cdata`)}`.execute(executor).catch(() => null);
  if (!res) return null;
  return new Set(res.rows.map((r) => String(r.Field)));
}

/**
 * DynamicFormEntry::save per un'entry nuova: riga form_entry (created = updated = NOW()), una
 * risposta per ogni campo con dati memorizzabile e non "presentation only", poi l'upsert della
 * colonna corrispondente in *__cdata (solo se tabella e colonna esistono, come il PHP).
 */
export async function saveFormEntry(
  executor: DbOrTx,
  inst: FormInstance,
  objectType: "T" | "U" | "O" | "A",
  objectId: number,
): Promise<number> {
  const res = await executor
    .insertInto("form_entry")
    .values({
      form_id: inst.def.id,
      object_id: objectId,
      object_type: objectType,
      sort: inst.sort,
      extra: inst.extra,
      created: NOW,
      updated: NOW,
    })
    .executeTakeFirstOrThrow();
  const entryId = Number(res.insertId);

  const cdata = CDATA[inst.def.type];
  const columns = cdata ? await cdataColumns(executor, cdata.table) : null;
  for (const f of inst.fields) {
    if (!hasData(f) || !isStorable(f) || isPresentationOnly(f)) continue;
    const value = inst.effective(f);
    const db = fieldToDatabase(f, value);
    await executor.insertInto("form_entry_values").values({ entry_id: entryId, field_id: f.id, value: db.value, value_id: db.valueId }).execute();
    if (cdata && columns) {
      const col = f.name || `field_${f.id}`;
      if (!columns.has(col)) continue;
      const keys = fieldSearchKeys(f, value);
      await sql`INSERT INTO ${table(cdata.table as `${string}__cdata`)} SET ${sql.ref(col)} = ${keys}, ${sql.ref(cdata.key)} = ${objectId}
        ON DUPLICATE KEY UPDATE ${sql.ref(col)} = ${keys}`.execute(executor);
    }
  }
  return entryId;
}
