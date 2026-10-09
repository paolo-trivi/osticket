import "server-only";

import { sql } from "kysely";

import { NOW, type DbOrTx } from "../../db";
import { stripTags } from "../../format/html";
import { phpJsonEncode, phpJsonDecode } from "../../format/php-json";
import { stripEmoticons } from "../../format/text";
import type { MassResult, SaveResult } from "../admin/common";
import { OrmRow, SQL_NOW } from "../admin/orm";
import { formatHtmlchars, isNumeric, isset, phpLooseEquals, str, truthy, type PhpVal, type PhpVars } from "../admin/php";
import type { Errors } from "../admin/validator";
import { isEmail } from "../directory/forms";
import { sanitizeHtml } from "./sanitize";

/**
 * Liste personalizzate: scp/lists.php (DynamicList::add/update/delete, proprietà = campi del form
 * "L<id>") e include/ajax.forms.php (elementi: addListItem, saveListItem, disable/undisable/delete).
 *
 * Differenze annotate:
 * - la lista di sistema degli stati dei ticket (handler TicketStatusList) è in sola lettura: i suoi
 *   elementi sono le righe di ticket_status, gestite dal pannello PHP;
 * - le proprietà degli elementi sono gestite per i campi "text" e "memo"; con altri tipi di campo
 *   (scelte, date, caselle…) il salvataggio delle proprietà resta al PHP (errore `unsupported_property`);
 * - l'importazione CSV degli elementi resta al PHP;
 * - DynamicList::delete non controlla la maschera MASK_DELETE: qui una lista non eliminabile non si
 *   elimina (regola più stretta, annotata).
 * Stranezze replicate: POST passato due volte per Format::htmlchars (con sanitize); l'unicità del
 * valore in modifica è verificata sul valore attuale (non su quello nuovo); "eliminare" un elemento
 * azzera solo list_id; addItem con un valore già presente (anche disattivato) riusa quell'elemento.
 */
export const ListMask = { EDIT: 0x0001, ADD: 0x0002, DELETE: 0x0004, ABBREV: 0x0008 } as const;
export const ItemStatus = { ENABLED: 0x0001, INTERNAL: 0x0002 } as const;
export const SORT_MODES = ["Alpha", "-Alpha", "SortCol"] as const;
const LIST_FIELDS = ["name", "name_plural", "sort_mode", "notes"] as const;
const PROPERTY_FLAGS = 0x00001 | 0x01000 | 0x02000;

/** Format::htmlchars($vars, $sanitize) ricorsivo. */
export function htmlcharsVars(vars: PhpVars, sanitize: boolean): PhpVars {
  const conv = (v: PhpVal): PhpVal => {
    if (v === undefined || v === null) return v;
    if (Array.isArray(v)) return v.map(conv);
    if (typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, conv(x)]));
    return formatHtmlchars(sanitize ? sanitizeHtml(str(v)) : str(v));
  };
  const out: PhpVars = {};
  for (const [k, v] of Object.entries(vars)) out[k] = conv(v);
  return out;
}

export async function loadList(executor: DbOrTx, id: number) {
  return (await executor.selectFrom("list").selectAll().where("id", "=", id).executeTakeFirst()) ?? null;
}

const hasHandler = (l: { configuration: string | null }) => !!phpJsonDecode<{ handler?: string }>(l.configuration, {}).handler;

/** DynamicList::getConfigurationForm($autocreate): form "L<id>" (creato se manca). */
async function propertiesForm(executor: DbOrTx, list: { id: number; name: string }, autocreate: boolean): Promise<number | null> {
  const form = await executor.selectFrom("form").select("id").where("type", "=", `L${list.id}`).executeTakeFirst();
  if (form) return form.id;
  if (!autocreate) return null;
  const f = OrmRow.create("form", "id", { touchUpdated: true });
  f.set("type", `L${list.id}`);
  f.set("title", `${list.name} Properties`);
  f.set("created", SQL_NOW);
  await f.save(executor);
  return f.num("id");
}

/** Nuovi campi proprietà (prop-label-new-<i> …) come il ciclo finale di scp/lists.php. */
async function addNewProperties(executor: DbOrTx, formId: number, info: PhpVars, maxSort: number, errors: Errors): Promise<void> {
  for (let i = 0; isset(info, `prop-sort-new-${i}`); i++) {
    if (!truthy(info[`prop-label-new-${i}`])) continue;
    const field = OrmRow.create("form_field", "id", { touchUpdated: true });
    field.set("sort", truthy(info[`prop-sort-new-${i}`]) ? str(info[`prop-sort-new-${i}`]) : ++maxSort);
    field.set("label", str(info[`prop-label-new-${i}`]));
    field.set("type", info[`type-new-${i}`] === undefined ? null : str(info[`type-new-${i}`]));
    field.set("name", info[`name-new-${i}`] === undefined ? null : str(info[`name-new-${i}`]));
    field.set("flags", PROPERTY_FLAGS);
    field.set("created", SQL_NOW);
    const err = fieldTemplateErrors(field);
    if (err.length) {
      errors[`new-${i}`] = err.join(", ");
      continue;
    }
    field.set("form_id", formId);
    await field.save(executor);
  }
}

/** DynamicFormField::isValid (validazione del modello di campo). */
export function fieldTemplateErrors(field: OrmRow, extra: string[] = []): string[] {
  const errors = [...extra];
  if (errors.length) return errors;
  if (!truthy(field.get("label") as PhpVal)) errors.push("label_required");
  const flags = field.num("flags");
  const name = str(field.get("name") as PhpVal);
  if (flags & (0x04000 | 0x00400) && !name) errors.push("name_required");
  // [[:alnum:]] con /u ma senza UCP: solo ASCII
  if (name && !/^(?!\d)[A-Za-z0-9_]+$/.test(name)) errors.push("name_invalid");
  return errors;
}

/** scp/lists.php do=add → DynamicList::add + proprietà nuove */
export async function addList(executor: DbOrTx, post: PhpVars): Promise<SaveResult> {
  const info = htmlcharsVars(post, true);
  const vars = htmlcharsVars(info, false);
  const errors: Errors = {};
  const ht: Record<string, string> = {};
  for (const f of LIST_FIELDS) {
    if (f === "name" && !truthy(vars[f])) errors[f] = "required";
    else if (isset(vars, f)) ht[f] = str(vars[f]);
  }
  if (!Object.keys(ht).length || Object.keys(errors).length) return { ok: false, errors };
  const list = OrmRow.create("list", "id", { touchUpdated: true });
  for (const [k, v] of Object.entries(ht)) list.set(k, v);
  list.set("created", SQL_NOW);
  if (list.dirty.has("notes")) list.set("notes", sanitizeHtml(str(list.get("notes") as PhpVal)));
  await list.save(executor);
  const id = list.num("id");
  const formId = await propertiesForm(executor, { id, name: str(list.get("name") as PhpVal) }, true);
  if (formId) await addNewProperties(executor, formId, info, 0, errors);
  return { ok: true, id, errors: {} };
}

/** scp/lists.php do=update */
export async function updateList(executor: DbOrTx, listId: number, post: PhpVars): Promise<SaveResult> {
  const row = await loadList(executor, listId);
  if (!row) return { ok: false, errors: { err: "unknown" } };
  if (hasHandler(row)) return { ok: false, errors: { err: "system_list" } };
  const info = htmlcharsVars(post, true);
  const vars = htmlcharsVars(info, false);
  const errors: Errors = {};
  const list = OrmRow.from("list", "id", row as unknown as Record<string, unknown>, { touchUpdated: true });
  const editable = !(row.masks & ListMask.EDIT);
  for (const f of LIST_FIELDS) {
    if (f === "name" && editable && !truthy(vars[f])) errors[f] = "required";
    else if (isset(vars, f) && !phpLooseEquals(vars[f], list.get(f) as PhpVal)) list.set(f, str(vars[f]));
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  if (list.dirty.has("notes")) list.set("notes", sanitizeHtml(str(list.get("notes") as PhpVal)));
  await list.save(executor);

  // ordinamento manuale degli elementi
  if (list.get("sort_mode") === "SortCol") {
    const items = await executor.selectFrom("list_items").selectAll().where("list_id", "=", listId).orderBy("sort").execute();
    for (const it of items) {
      if (!isset(info, `sort-${it.id}`)) continue;
      const item = OrmRow.from("list_items", "id", it as unknown as Record<string, unknown>);
      item.set("sort", str(info[`sort-${it.id}`]));
      item.set("value", str(item.get("value") as PhpVal).trim());
      await item.save(executor);
    }
  }

  // proprietà (campi del form L<id>)
  let maxSort = 0;
  const formId = await propertiesForm(executor, { id: listId, name: str(list.get("name") as PhpVal) }, true);
  if (formId) {
    const names: string[] = [];
    const fields = await executor.selectFrom("form_field").selectAll().where("form_id", "=", formId).orderBy("sort").execute();
    for (const fr of fields) {
      const id = fr.id;
      const field = OrmRow.from("form_field", "id", fr as unknown as Record<string, unknown>, { touchUpdated: true });
      const flags = fr.flags ?? 0;
      if (info[`delete-prop-${id}`] === "on" && !(flags & 0x00020)) {
        await deleteField(executor, fr);
        continue;
      }
      if (isset(info, `type-${id}`) && !(flags & 0x00010)) field.set("type", str(info[`type-${id}`]));
      if (isset(info, `name-${id}`) && !(flags & 0x40000)) field.set("name", str(info[`name-${id}`]));
      for (const f of ["sort", "label"]) if (isset(info, `prop-${f}-${id}`)) field.set(f, str(info[`prop-${f}-${id}`]));
      const extra: string[] = [];
      const name = str(field.get("name") as PhpVal);
      if (names.includes(name)) extra.push("name_not_unique");
      if (/[.{}'"`; ]/u.test(name)) extra.push("name_invalid");
      if (name) names.push(name);
      if (!fieldTemplateErrors(field, extra).length) await field.save(executor);
      else errors[`field-${id}`] = "field_errors";
      maxSort = Math.max(maxSort, Number(field.get("sort") ?? 0) || 0);
    }
    await addNewProperties(executor, formId, info, maxSort, errors);
  }
  if (Object.keys(errors).length) return { ok: false, errors: { ...errors, err: "items_errors" } };
  return { ok: true, id: listId, errors: {} };
}

/** DynamicFormField::delete: con risposte salvate il campo viene solo staccato dal form. */
export async function deleteField(executor: DbOrTx, fr: { id: number; type: string }): Promise<void> {
  const answers = await executor.selectFrom("form_entry_values").select("entry_id").where("field_id", "=", fr.id).executeTakeFirst();
  // db_cleanup: il campo "info" elimina i propri allegati inline (tipo I)
  if (fr.type === "info") {
    const files = await executor.selectFrom("attachment").select("id").where("object_id", "=", fr.id).where("type", "=", "I").execute();
    if (files.length) await executor.deleteFrom("attachment").where("object_id", "=", fr.id).where("type", "=", "I").execute();
  }
  const hasData = !["break", "info"].includes(fr.type);
  if (hasData && answers) {
    await executor.updateTable("form_field").set({ form_id: 0, updated: NOW }).where("id", "=", fr.id).execute();
    return;
  }
  await executor.deleteFrom("form_field").where("id", "=", fr.id).execute();
}


/** scp/lists.php do=mass_process a=delete */
export async function deleteLists(executor: DbOrTx, ids: number[]): Promise<MassResult> {
  if (!ids.length) return { ok: false, num: 0, error: "select_one" };
  let i = 0;
  for (const id of ids) {
    const list = await loadList(executor, id);
    if (!list || list.masks & ListMask.DELETE) continue;
    const used = await executor.selectFrom("form_field").select("id").where("type", "=", `list-${id}`).executeTakeFirst();
    if (used) continue;
    await executor.deleteFrom("list").where("id", "=", id).execute();
    const form = await executor.selectFrom("form").selectAll().where("type", "=", `L${id}`).executeTakeFirst();
    if (form) {
      if (form.flags & 0x0001) {
        const f = OrmRow.from("form", "id", form as unknown as Record<string, unknown>, { touchUpdated: true });
        f.set("flags", form.flags | 0x0002);
        await f.save(executor);
      }
      await executor.deleteFrom("form_field").where("form_id", "=", form.id).execute();
    }
    i++;
  }
  return i ? { ok: true, num: i } : { ok: false, num: 0, error: "in_use" };
}

// ---------------------------------------------------------------- elementi

interface PropField {
  id: number;
  type: string;
  name: string;
  flags: number;
  configuration: string | null;
}

async function propertyFields(executor: DbOrTx, listId: number): Promise<PropField[]> {
  const form = await executor.selectFrom("form").select("id").where("type", "=", `L${listId}`).executeTakeFirst();
  if (!form) return [];
  return (await executor
    .selectFrom("form_field")
    .select(["id", "type", "name", "flags", "configuration"])
    .where("form_id", "=", form.id)
    .orderBy("sort")
    .execute()) as PropField[];
}

/** Validatore dei TextboxField (formula se non configurato). */
function textboxErrors(value: string, required: boolean, validator: string): string[] {
  const out: string[] = [];
  const v = value === "0" ? "&#48" : str(formatHtmlchars(value));
  if (required && !truthy(v)) out.push("required");
  if (!truthy(v)) return out;
  const valid = validator || "formula";
  if (valid === "formula" && !/(^[^=+@-].*$)|(^\+\d+$)/s.test(v)) out.push("formula");
  if (valid === "email" && !isEmail(v)) out.push("email");
  if (valid === "number" && !isNumeric(v === "&#48" ? 0 : v)) out.push("number");
  return out;
}

/** DynamicListItem::setConfiguration($_POST): proprietà come {id campo: valore}. */
async function itemProperties(executor: DbOrTx, listId: number, vars: PhpVars): Promise<{ json: string; errors: string[] } | "unsupported"> {
  const config: Record<string, PhpVal> = {};
  const errors: string[] = [];
  for (const f of await propertyFields(executor, listId)) {
    if (f.type === "break" || f.type === "info") continue;
    const cfg = phpJsonDecode<Record<string, unknown>>(f.configuration, {});
    const raw = vars[f.name] !== undefined && f.name ? vars[f.name] : vars[String(f.id)];
    const required = !!(f.flags & 0x04000);
    if (f.type === "text") {
      const clean = stripEmoticons(stripTags(str(raw)));
      errors.push(...textboxErrors(clean, required, str(cfg.validator as PhpVal)));
      config[String(f.id)] = clean;
    } else if (f.type === "memo") {
      const html = cfg.html === undefined ? true : !!cfg.html;
      const clean = html ? sanitizeHtml(str(raw)) : str(raw);
      if (required && !truthy(clean)) errors.push("required");
      config[String(f.id)] = clean;
    } else return "unsupported";
  }
  return { json: Object.keys(config).length ? phpJsonEncode(config) : "[]", errors };
}

/** ajax.forms.php addListItem: valore obbligatorio, unico tra gli elementi attivi. */
export async function addListItem(executor: DbOrTx, listId: number, vars: PhpVars): Promise<SaveResult> {
  const list = await loadList(executor, listId);
  if (!list) return { ok: false, errors: { err: "unknown" } };
  if (hasHandler(list)) return { ok: false, errors: { err: "system_list" } };
  const value = stripEmoticons(stripTags(str(vars.value)));
  const extra = stripEmoticons(stripTags(str(vars.extra)));
  const formErrors = [...textboxErrors(value, true, "").map((e) => ["value", e]), ...textboxErrors(extra, false, "").map((e) => ["extra", e])];
  if (formErrors.length) return { ok: false, errors: Object.fromEntries(formErrors) };
  const dup = await executor.selectFrom("list_items").select("id").where("list_id", "=", listId).where("value", "=", value).where(sql<number>`status & ${ItemStatus.ENABLED}`, "<>", 0).executeTakeFirst();
  if (dup) return { ok: false, errors: { value: "value_in_use" } };
  const props = await itemProperties(executor, listId, vars);
  if (props === "unsupported") return { ok: false, errors: { err: "unsupported_property" } };
  // DynamicList::addItem: un elemento con lo stesso valore (anche disattivato) viene riusato
  const existing = await executor.selectFrom("list_items").selectAll().where("list_id", "=", listId).where("value", "=", value).orderBy("id").executeTakeFirst();
  const item = existing ? OrmRow.from("list_items", "id", existing as unknown as Record<string, unknown>) : OrmRow.create("list_items", "id");
  if (!existing) {
    item.set("status", 1);
    item.set("list_id", listId);
    item.set("sort", null);
    item.set("value", value);
    item.set("extra", extra);
  }
  if (props.errors.length) return { ok: false, errors: { properties: props.errors.join(", ") } };
  item.set("properties", props.json);
  item.set("value", str(item.get("value") as PhpVal).trim());
  await item.save(executor);
  return { ok: true, id: item.num("id"), errors: {} };
}

/** ajax.forms.php saveListItem */
export async function updateListItem(executor: DbOrTx, listId: number, itemId: number, vars: PhpVars): Promise<SaveResult> {
  const list = await loadList(executor, listId);
  if (!list) return { ok: false, errors: { err: "unknown" } };
  if (hasHandler(list)) return { ok: false, errors: { err: "system_list" } };
  const row = await executor.selectFrom("list_items").selectAll().where("list_id", "=", listId).where("id", "=", itemId).executeTakeFirst();
  if (!row) return { ok: false, errors: { err: "unknown_item" } };
  const value = stripEmoticons(stripTags(str(vars.value)));
  const extra = stripEmoticons(stripTags(str(vars.extra)));
  const formErrors = [...textboxErrors(value, true, "").map((e) => ["value", e]), ...textboxErrors(extra, false, "").map((e) => ["extra", e])];
  if (formErrors.length) return { ok: false, errors: Object.fromEntries(formErrors) };
  // Bug PHP replicato: il controllo di unicità (sul valore attuale, non su quello nuovo) aggiunge
  // l'errore al campo dopo che Form::isValid() ha già memorizzato l'esito: non blocca mai.
  const props = await itemProperties(executor, listId, vars);
  if (props === "unsupported") return { ok: false, errors: { err: "unsupported_property" } };
  const item = OrmRow.from("list_items", "id", row as unknown as Record<string, unknown>);
  // DynamicListItem::update
  if (!truthy(value)) return { ok: false, errors: { [`value-${itemId}`]: "value_required" } };
  item.set("value", value);
  item.set("extra", truthy(extra) ? extra : null);
  item.set("value", str(item.get("value") as PhpVal).trim());
  await item.save(executor);
  if (props.errors.length) return { ok: false, errors: { properties: props.errors.join(", ") } };
  item.set("properties", props.json);
  await item.save(executor);
  return { ok: true, id: itemId, errors: {} };
}

export type ItemMassAction = "enable" | "disable" | "delete";

/** ajax.forms.php disableItems / undisableItems / deleteItems */
export async function massListItems(executor: DbOrTx, listId: number, action: ItemMassAction, ids: number[]): Promise<MassResult> {
  const list = await loadList(executor, listId);
  if (!list) return { ok: false, num: 0, error: "unknown" };
  if (hasHandler(list)) return { ok: false, num: 0, error: "system_list" };
  if (!ids.length) return { ok: false, num: 0, error: "select_one" };
  let num = 0;
  for (const id of ids) {
    const row = await executor.selectFrom("list_items").selectAll().where("list_id", "=", listId).where("id", "=", id).executeTakeFirst();
    if (!row) return { ok: num > 0, num, error: "unknown_item" };
    const item = OrmRow.from("list_items", "id", row as unknown as Record<string, unknown>);
    if (action === "enable") item.set("status", row.status | ItemStatus.ENABLED);
    else if (action === "disable") item.set("status", row.status & ~ItemStatus.ENABLED);
    else item.set("list_id", null);
    item.set("value", str(item.get("value") as PhpVal).trim());
    await item.save(executor);
    num++;
  }
  return { ok: true, num };
}

export async function listLists(executor: DbOrTx) {
  const lists = await executor.selectFrom("list").selectAll().orderBy("name").execute();
  const out = [];
  for (const l of lists) {
    const n = await executor.selectFrom("list_items").select((eb) => eb.fn.countAll<number>().as("n")).where("list_id", "=", l.id).executeTakeFirstOrThrow();
    out.push({ ...l, items: Number(n.n), system: hasHandler(l) });
  }
  return out;
}

export async function listDetail(executor: DbOrTx, listId: number) {
  const list = await loadList(executor, listId);
  if (!list) return null;
  const order = list.sort_mode === "SortCol" ? "sort" : "value";
  const items = hasHandler(list)
    ? []
    : await executor
        .selectFrom("list_items")
        .selectAll()
        .where("list_id", "=", listId)
        .orderBy(order, list.sort_mode === "-Alpha" ? "desc" : "asc")
        .execute();
  const form = await executor.selectFrom("form").select("id").where("type", "=", `L${listId}`).executeTakeFirst();
  const properties = form ? await executor.selectFrom("form_field").selectAll().where("form_id", "=", form.id).orderBy("sort").execute() : [];
  return { list, items, properties, system: hasHandler(list) };
}
