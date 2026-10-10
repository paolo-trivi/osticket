import "server-only";

import { sql } from "kysely";

import { DynamicListItem } from "@/lib/osticket/flags";

import { loadConfigNamespace, type ConfigNamespace } from "../../config/config";
import type { DbOrTx } from "../../db";
import { phpJsonEncode } from "../../format/php-json";
import { str, truthy, type PhpVal, type PhpVars } from "../../php/values";
import type { MassResult, SaveResult } from "../admin/common";
import { OrmRow } from "../admin/orm";
import { fieldConfig, isRequiredFor, parseFieldValue, validateField, type CleanValue, type FieldDef } from "../forms/fields";
import { hasHandler, loadList } from "./list";

/**
 * Elementi delle liste personalizzate: include/ajax.forms.php (addListItem, saveListItem,
 * disable/undisable/delete) → DynamicListItem e DynamicList::addItem (include/class.list.php).
 *
 * Differenze annotate:
 * - gli elementi della lista di sistema degli stati dei ticket (TicketStatusList) sono le righe di
 *   ticket_status, gestite dal pannello PHP;
 * - le proprietà degli elementi sono gestite per i campi "text" e "memo"; con altri tipi di campo
 *   (scelte, date, caselle…) il salvataggio delle proprietà resta al PHP (errore `unsupported_property`);
 * - l'importazione CSV degli elementi resta al PHP.
 * Stranezze replicate: l'unicità del valore in modifica è verificata sul valore attuale (non su
 * quello nuovo); "eliminare" un elemento azzera solo list_id; addItem con un valore già presente
 * (anche disattivato) riusa quell'elemento.
 */

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

/** Campo da un modello form_field (configurazione con i default del tipo, come FormField::getConfiguration). */
function fieldDefOf(f: PropField, cfg: ConfigNamespace): FieldDef {
  return { id: f.id, formId: 0, type: f.type, label: "", name: f.name, hint: "", flags: f.flags, sort: 0, config: fieldConfig(f.type, f.configuration, cfg) };
}

/**
 * Valore ed errori di un campo del form degli elementi o delle proprietà con il motore dei form
 * (FormField::parse + validateEntry): un valore assente è letto come testo vuoto.
 */
async function cleanAndValidate(f: FieldDef, raw: PhpVal, required: boolean, cfg: ConfigNamespace): Promise<{ clean: CleanValue; errors: string[] }> {
  const clean = parseFieldValue(f, raw ?? "");
  return { clean, errors: await validateField(f, clean, required, cfg) };
}

/** Campi "value" ed "extra" del form degli elementi (TextboxField senza validatore → formula). */
async function itemTextFields(executor: DbOrTx, vars: PhpVars): Promise<{ value: string; extra: string; errors: [string, string][] }> {
  const cfg = await loadConfigNamespace("core", executor);
  const field = (name: string) => fieldDefOf({ id: 0, type: "text", name, flags: 0, configuration: null }, cfg);
  const value = await cleanAndValidate(field("value"), vars.value, true, cfg);
  const extra = await cleanAndValidate(field("extra"), vars.extra, false, cfg);
  return {
    value: str(value.clean as PhpVal),
    extra: str(extra.clean as PhpVal),
    errors: [...value.errors.map((e): [string, string] => ["value", e]), ...extra.errors.map((e): [string, string] => ["extra", e])],
  };
}

/** DynamicListItem::setConfiguration($_POST): proprietà come {id campo: valore}. */
async function itemProperties(executor: DbOrTx, listId: number, vars: PhpVars): Promise<{ json: string; errors: string[] } | "unsupported"> {
  const config: Record<string, PhpVal> = {};
  const errors: string[] = [];
  const cfg = await loadConfigNamespace("core", executor);
  for (const f of await propertyFields(executor, listId)) {
    if (f.type === "break" || f.type === "info") continue;
    if (f.type !== "text" && f.type !== "memo") return "unsupported";
    const def = fieldDefOf(f, cfg);
    const raw = vars[f.name] !== undefined && f.name ? vars[f.name] : vars[String(f.id)];
    const r = await cleanAndValidate(def, raw, isRequiredFor(def, "staff"), cfg);
    errors.push(...r.errors);
    config[String(f.id)] = r.clean as PhpVal;
  }
  return { json: Object.keys(config).length ? phpJsonEncode(config) : "[]", errors };
}

/** ajax.forms.php addListItem: valore obbligatorio, unico tra gli elementi attivi. */
export async function addListItem(executor: DbOrTx, listId: number, vars: PhpVars): Promise<SaveResult> {
  const list = await loadList(executor, listId);
  if (!list) return { ok: false, errors: { err: "unknown" } };
  if (hasHandler(list)) return { ok: false, errors: { err: "system_list" } };
  const { value, extra, errors: formErrors } = await itemTextFields(executor, vars);
  if (formErrors.length) return { ok: false, errors: Object.fromEntries(formErrors) };
  const dup = await executor.selectFrom("list_items").select("id").where("list_id", "=", listId).where("value", "=", value).where(sql<number>`status & ${DynamicListItem.ENABLED}`, "<>", 0).executeTakeFirst();
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
  const { value, extra, errors: formErrors } = await itemTextFields(executor, vars);
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
    if (action === "enable") item.set("status", row.status | DynamicListItem.ENABLED);
    else if (action === "disable") item.set("status", row.status & ~DynamicListItem.ENABLED);
    else item.set("list_id", null);
    item.set("value", str(item.get("value") as PhpVal).trim());
    await item.save(executor);
    num++;
  }
  return { ok: true, num };
}
