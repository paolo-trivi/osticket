import "server-only";

import { sql } from "kysely";

import type { ConfigNamespace } from "../../config/config";
import { NOW, table, type DbOrTx } from "../../db";
import { phpJsonDecode } from "../../format/php-json";
import {
  fieldSearchKeys,
  fieldSearchable,
  fieldToDatabase,
  fieldToString,
  hasData,
  isIdValue,
  isPresentationOnly,
  isStorable,
  parseField,
  validateField,
  type CleanValue,
  type DateFormatOptions,
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
    /** fuso dell'utente corrente (campi data) e formati delle date per filtri e indice */
    readonly opts: { timezone?: string; dates?: DateFormatOptions } = {},
  ) {
    for (const f of def.fields) if (hasData(f)) this.values.set(f.id, parseField(f, source, opts.timezone ?? opts.dates?.timezone));
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
      const v = isPresentationOnly(f) ? (this.source.message as string | undefined) ?? "" : fieldToString(f, this.effective(f), this.opts.dates);
      if (v) out[`field.${f.id}`] = v;
    }
    return out;
  }

  /**
   * SelectionField::getFilterData per i campi lista: per ogni voce scelta `field.<id>.abb` (extra) e le
   * proprietà `field.<id>.<prop>`; DynamicListItem::getFilterData chiama DynamicList::getForm() che
   * crea al volo il form "L<lista>" delle proprietà se manca (effetto collaterale replicato).
   */
  async listFilterData(executor: DbOrTx): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const f of this.def.fields) {
      if (!f.type.startsWith("list-") || !hasData(f)) continue;
      const v = this.effective(f);
      if (!v || typeof v !== "object" || isIdValue(v)) continue;
      const data: Record<string, string> = {};
      for (const id of Object.keys(v)) {
        const item = await executor.selectFrom("list_items").select(["id", "list_id", "extra", "properties"]).where("id", "=", Number(id)).executeTakeFirst();
        if (!item || !item.list_id) continue;
        const formId = await ensureListPropertiesForm(executor, item.list_id);
        const props = phpJsonDecode<Record<string, unknown>>(item.properties, {}) ?? {};
        const pf = formId ? await executor.selectFrom("form_field").select(["id"]).where("form_id", "=", formId).orderBy("sort").execute() : [];
        const itemData: Record<string, string> = {};
        for (const F of pf) itemData[`.${F.id}`] = props[String(F.id)] === undefined || props[String(F.id)] === null ? "" : String(props[String(F.id)]);
        itemData[".abb"] = item.extra ?? "";
        for (const [k, val] of Object.entries(itemData)) data[k] = k in data ? `${data[k]} ${val}` : val;
      }
      for (const [k, val] of Object.entries(data)) if (val) out[`field.${f.id}${k}`] = val;
    }
    return out;
  }

  /** Testi indicizzabili delle risposte (SearchBackend per User/Organization) */
  searchables(skip: string[] = []): string[] {
    const out: string[] = [];
    for (const f of this.def.fields) {
      if (!hasData(f) || !isStorable(f) || isPresentationOnly(f) || skip.includes(f.name)) continue;
      const v = fieldSearchable(f, this.effective(f), this.opts.dates);
      if (v) out.push(v);
    }
    return out;
  }
}

/** DynamicList::getConfigurationForm(autocreate): form "L<id>" delle proprietà, creato se manca */
export async function ensureListPropertiesForm(executor: DbOrTx, listId: number): Promise<number | null> {
  const form = await executor.selectFrom("form").select("id").where("type", "=", `L${listId}`).orderBy("id").executeTakeFirst();
  if (form) return form.id;
  const list = await executor.selectFrom("list").select(["id", "name"]).where("id", "=", listId).executeTakeFirst();
  if (!list) return null;
  const res = await executor
    .insertInto("form")
    .values({ type: `L${listId}`, title: `${list.name} Properties`, created: NOW, updated: NOW })
    .executeTakeFirstOrThrow();
  return Number(res.insertId);
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
