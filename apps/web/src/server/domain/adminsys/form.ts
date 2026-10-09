import "server-only";

import { htmlDecode } from "../../format/html";
import type { DbOrTx } from "../../db";
import { htmlcharsVars, isset, str, truthy, type PhpVal, type PhpVars } from "../../php/values";
import type { MassResult, SaveResult } from "../admin/common";
import { OrmRow, SQL_NOW } from "../admin/orm";
import type { Errors } from "../admin/validator";
import { CDATA_FORM_TYPES } from "../forms/cdata";
import { FieldFlag } from "../forms/fields";
import { deleteField, fieldTemplateErrors } from "./list";
import { pv } from "./orm-util";

/**
 * Form personalizzati: scp/forms.php (DynamicForm e DynamicFormField, include/class.dynamic_forms.php).
 *
 * DDL: nei form dei ticket (T), dei task (A), degli utenti (U) e delle organizzazioni (O) la
 * creazione di un campo o il cambio di nome/tipo di un campo esistente fanno ricreare al PHP la
 * tabella `*__cdata` (Signal model.created / model.updated → dropDynamicDataView + CREATE TABLE … AS
 * SELECT). Next non esegue DDL: queste modifiche vengono rifiutate prima di qualsiasi scrittura con
 * l'errore `ddl_required` e restano al pannello PHP. Etichette, ordinamento, visibilità
 * dei campi esistenti ed eliminazioni (il campo viene prima staccato dal form) non toccano cdata.
 *
 * La configurazione dei singoli campi (finestra "Config" del PHP, setConfiguration per tipo) resta
 * al pannello PHP. Le traduzioni (trans[…]) non sono gestite.
 *
 * Stranezze replicate: in "update" il form (titolo, istruzioni, note) viene salvato subito, anche se
 * poi i campi hanno errori; le eliminazioni dei campi avvengono subito; i valori del POST passano
 * per Format::htmlchars con sanitize (le istruzioni vengono poi decodificate).
 */
export const FormFlag = { DELETABLE: 0x0001, DELETED: 0x0002 } as const;

const F = FieldFlag;
/** DynamicFormField::allRequirementModes */
export const REQUIREMENT_MODES: Record<string, number> = {
  a: F.CLIENT_VIEW | F.AGENT_VIEW | F.CLIENT_EDIT | F.AGENT_EDIT,
  b: F.CLIENT_VIEW | F.AGENT_VIEW | F.CLIENT_EDIT | F.AGENT_EDIT | F.CLIENT_REQUIRED | F.AGENT_REQUIRED,
  c: F.CLIENT_VIEW | F.AGENT_VIEW | F.CLIENT_EDIT | F.AGENT_EDIT | F.CLIENT_REQUIRED,
  d: F.CLIENT_VIEW | F.AGENT_VIEW | F.CLIENT_EDIT | F.AGENT_EDIT | F.AGENT_REQUIRED,
  e: F.AGENT_VIEW | F.AGENT_EDIT,
  f: F.AGENT_VIEW | F.AGENT_EDIT | F.AGENT_REQUIRED,
  g: F.CLIENT_VIEW | F.CLIENT_EDIT | F.CLIENT_REQUIRED,
};
export const FIELD_TYPES = ["text", "memo", "thread", "datetime", "timezone", "phone", "bool", "choices", "files", "break", "info"];

/** setRequirementMode($mode): modalità filtrate per i campi a privacy o obbligatorietà forzata. */
function setRequirementMode(field: OrmRow, mode: PhpVal): void {
  const flags = field.num("flags");
  const m = str(mode);
  const bits = REQUIREMENT_MODES[m];
  if (bits === undefined || mode === undefined || mode === null) return;
  if (flags & 0x20000 && bits & (F.CLIENT_VIEW | F.AGENT_VIEW)) return;
  if (flags & 0x10000 && bits & (F.CLIENT_REQUIRED | F.AGENT_REQUIRED)) return;
  field.set("flags", bits | F.ENABLED);
}

/** Campi del form nel nuovo POST (sort-new-<i> …). */
function newFieldIndexes(post: PhpVars): number[] {
  const out: number[] = [];
  for (let i = 0; isset(post, `sort-new-${i}`); i++) if (truthy(post[`label-new-${i}`])) out.push(i);
  return out;
}

interface FormRow {
  id: number;
  type: string;
  flags: number;
}

/** Modifiche che richiederebbero al PHP di ricreare la tabella cdata. */
async function needsDdl(executor: DbOrTx, form: FormRow | null, post: PhpVars): Promise<boolean> {
  if (!form || !CDATA_FORM_TYPES.includes(form.type)) return false;
  if (newFieldIndexes(post).length) return true;
  const fields = await executor.selectFrom("form_field").selectAll().where("form_id", "=", form.id).execute();
  for (const f of fields) {
    if (post[`delete-${f.id}`] === "on" && !((f.flags ?? 0) & F.MASK_DELETE)) continue;
    if (isset(post, `type-${f.id}`) && !((f.flags ?? 0) & F.MASK_CHANGE) && str(post[`type-${f.id}`]) !== f.type) return true;
    if (isset(post, `name-${f.id}`) && !((f.flags ?? 0) & F.MASK_NAME) && str(post[`name-${f.id}`]).trim() !== f.name) return true;
  }
  return false;
}

/** scp/forms.php do=update / do=add */
export async function saveForm(executor: DbOrTx, formId: number | null, rawPost: PhpVars): Promise<SaveResult> {
  const post = htmlcharsVars(rawPost, true);
  if (post.instructions !== undefined && post.instructions !== null) post.instructions = htmlDecode(str(post.instructions));
  const errors: Errors = {};
  let form: OrmRow;
  if (formId) {
    const row = await executor.selectFrom("form").selectAll().where("id", "=", formId).executeTakeFirst();
    if (!row) return { ok: false, errors: { err: "unknown" } };
    if (await needsDdl(executor, row as FormRow, post)) return { ok: false, errors: { err: "ddl_required" } };
    form = OrmRow.from("form", "id", row as unknown as Record<string, unknown>, { touchUpdated: true });
  } else {
    form = OrmRow.create("form", "id", { touchUpdated: true });
    form.set("created", SQL_NOW);
  }
  for (const f of ["title", "notes", "instructions"]) {
    if (f === "title" && !truthy(post[f])) errors[f] = "required";
    else if (isset(post, f)) form.set(f, str(post[f]));
  }
  const toSave: OrmRow[] = [];
  const names: string[] = [];
  let maxSort = 0;
  if (formId) {
    // update: il form viene salvato subito
    await form.save(executor);
    const fields = await executor.selectFrom("form_field").selectAll().where("form_id", "=", formId).orderBy("sort").execute();
    for (const fr of fields) {
      const id = fr.id;
      const flags = fr.flags ?? 0;
      if (post[`delete-${id}`] === "on" && !(flags & F.MASK_DELETE)) {
        if (truthy(post[`delete-data-${id}`])) await executor.deleteFrom("form_entry_values").where("field_id", "=", id).execute();
        await deleteField(executor, fr);
        continue;
      }
      const field = OrmRow.from("form_field", "id", fr as unknown as Record<string, unknown>, { touchUpdated: true });
      if (isset(post, `type-${id}`) && !(flags & F.MASK_CHANGE)) field.set("type", str(post[`type-${id}`]));
      if (isset(post, `name-${id}`) && !(flags & F.MASK_NAME)) field.set("name", str(post[`name-${id}`]).trim());
      setRequirementMode(field, post[`visibility-${id}`]);
      for (const f of ["sort", "label"]) if (isset(post, `${f}-${id}`)) field.set(f, str(post[`${f}-${id}`]));
      const extra: string[] = [];
      const name = str(pv(field.get("name"))).toLowerCase();
      if (names.includes(name)) extra.push("name_not_unique");
      if (form.get("type") === "T" && str(pv(field.get("name"))) === "subject" && ["break", "info"].includes(str(pv(field.get("type"))))) extra.push("subject_needs_input");
      if (str(pv(field.get("name")))) names.push(name);
      if (!fieldTemplateErrors(field, extra).length) toSave.push(field);
      else errors[`field-${id}`] = "field_errors";
      maxSort = Math.max(maxSort, Number(pv(field.get("sort")) ?? 0) || 0);
    }
  }
  for (const i of newFieldIndexes(post)) {
    const field = OrmRow.create("form_field", "id", { touchUpdated: true });
    field.set("sort", truthy(post[`sort-new-${i}`]) ? str(post[`sort-new-${i}`]) : ++maxSort);
    field.set("label", str(post[`label-new-${i}`]));
    field.set("type", post[`type-new-${i}`] === undefined ? null : str(post[`type-new-${i}`]));
    field.set("name", str(post[`name-new-${i}`]).trim());
    field.set("created", SQL_NOW);
    setRequirementMode(field, post[`visibility-new-${i}`]);
    const name = str(pv(field.get("name"))).toLowerCase();
    const extra = names.includes(name) ? ["name_not_unique"] : [];
    const errs = fieldTemplateErrors(field, extra);
    if (!errs.length) {
      toSave.push(field);
      if (name) names.push(name);
    } else errors[`new-${i}`] = errs.join(", ");
  }
  if (Object.keys(errors).length) return { ok: false, errors: { ...errors, err: "validation" } };
  await form.save(executor);
  const id = form.num("id");
  for (const field of toSave) {
    field.set("form_id", id);
    await field.save(executor);
  }
  return { ok: true, id, errors: {} };
}

/** scp/forms.php do=mass_process a=delete → DynamicForm::delete (eliminazione logica) */
export async function deleteForms(executor: DbOrTx, ids: number[]): Promise<MassResult> {
  if (!ids.length) return { ok: false, num: 0, error: "select_one" };
  let i = 0;
  for (const id of ids) {
    const row = await executor.selectFrom("form").selectAll().where("id", "=", id).executeTakeFirst();
    if (!row || !(row.flags & FormFlag.DELETABLE)) continue;
    const form = OrmRow.from("form", "id", row as unknown as Record<string, unknown>, { touchUpdated: true });
    form.set("flags", row.flags | FormFlag.DELETED);
    await form.save(executor);
    i++;
  }
  return i ? { ok: true, num: i } : { ok: false, num: 0, error: "failed" };
}

export async function listForms(executor: DbOrTx) {
  const rows = await executor
    .selectFrom("form as f")
    .select((eb) => [
      "f.id",
      "f.type",
      "f.title",
      "f.flags",
      "f.created",
      "f.updated",
      eb.selectFrom("form_field as x").select((e) => e.fn.countAll<number>().as("n")).whereRef("x.form_id", "=", "f.id").as("fields"),
    ])
    .where("f.type", "not like", "L%")
    .orderBy("f.title")
    .execute();
  return rows.filter((r) => !(r.flags & FormFlag.DELETED)).map((r) => ({ ...r, fields: Number(r.fields) }));
}

export async function formDetail(executor: DbOrTx, id: number) {
  const form = await executor.selectFrom("form").selectAll().where("id", "=", id).executeTakeFirst();
  if (!form) return null;
  const fields = await executor.selectFrom("form_field").selectAll().where("form_id", "=", id).orderBy("sort").execute();
  return { form, fields };
}
