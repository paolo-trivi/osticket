import "server-only";

import type { ConfigNamespace } from "../../config/config";
import { NOW, type DbOrTx } from "../../db";
import { phpJsonDecode } from "../../format/php-json";
import { phpLooseEquals } from "../../php/values";
import { cdataColumns, upsertCdata } from "./cdata";
import {
  fieldSearchKeys,
  fieldSearchable,
  fieldToDatabase,
  fieldToString,
  hasAnswerRow,
  hasData,
  isIdValue,
  isPresentationOnly,
  isStorable,
  parseField,
  phpCleanValue,
  validateField,
  type CleanValue,
  type DateFormatOptions,
  type FieldDef,
  type FieldErrorCode,
  type FormSource,
} from "./fields";
import type { WriteContext } from "../ticket/context";
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

  /**
   * FormField::getClean di tutti i campi con dati, per id e per nome (Form::getClean), nella forma del
   * PHP: è la sorgente che User::fromVars riceve e rilegge con i widget (addDynamicData).
   */
  cleanVars(): Record<string, CleanValue> {
    const out: Record<string, CleanValue> = {};
    for (const f of this.def.fields) {
      if (!hasData(f)) continue;
      const v = phpCleanValue(f, this.values.get(f.id) ?? null);
      out[String(f.id)] = v;
      if (f.name) out[f.name] = v;
    }
    return out;
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

/**
 * $cfg->getTimezone(): fuso dell'agente o dell'utente (account) corrente, altrimenti quello predefinito
 * della config. Usato per i campi data dei form e per formattare le date nei filtri e nell'indice.
 */
export async function currentTimezone(ctx: WriteContext): Promise<string> {
  if (ctx.agent?.row.timezone) return ctx.agent.row.timezone;
  if (ctx.actor?.kind === "user") {
    const a = await ctx.tx.selectFrom("user_account").select("timezone").where("user_id", "=", ctx.actor.id).executeTakeFirst();
    if (a?.timezone) return a.timezone;
  }
  return ctx.cfg.str("default_timezone") || "UTC";
}

/** Fuso e formati delle date dell'utente corrente (opzioni di FormInstance). */
export async function currentDates(ctx: WriteContext): Promise<DateFormatOptions> {
  return { cfg: ctx.cfg, timezone: await currentTimezone(ctx) };
}

/** Contesto della richiesta per transazione (vedi bindRequestContext). */
const requestContexts = new WeakMap<object, WriteContext>();

/**
 * Lega la transazione al contesto della richiesta (runWrite). Nel PHP $cfg->getTimezone() è globale
 * alla richiesta: anche chi riceve solo l'executor (TicketRecord.save → indice `_search`) deve
 * formattare le date nel fuso dell'utente corrente.
 */
export function bindRequestContext(ctx: WriteContext): void {
  requestContexts.set(ctx.tx, ctx);
}

/** currentDates del contesto legato all'executor; null fuori da una richiesta (cron, script). */
export async function requestDates(executor: DbOrTx): Promise<DateFormatOptions | null> {
  const ctx = requestContexts.get(executor);
  return ctx ? currentDates(ctx) : null;
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

  const columns = await cdataColumns(executor, inst.def.type);
  for (const f of inst.fields) {
    if (!hasAnswerRow(f)) continue;
    const value = inst.effective(f);
    const db = fieldToDatabase(f, value);
    // risposta nuova: VerySimpleModel inserisce solo i campi "sporchi", e un valore uguale a NULL per il
    // confronto debole ("", false) non lo è → la colonna resta NULL
    await executor
      .insertInto("form_entry_values")
      .values({ entry_id: entryId, field_id: f.id, value: phpLooseEquals(null, db.value) ? null : db.value, value_id: phpLooseEquals(null, db.valueId) ? null : db.valueId })
      .execute();
    await upsertCdata(executor, inst.def.type, objectId, f, fieldSearchKeys(f, value), columns);
  }
  return entryId;
}
