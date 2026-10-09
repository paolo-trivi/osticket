import "server-only";

import { NOW, type DbOrTx } from "../../db";
import {
  hasAnswerRow,
  inputFor,
  loadFormFields,
  parseInput,
  saveEntryAnswers,
  toDatabase,
  validateInput,
  type FieldDef,
  type FormEntry,
} from "../directory/forms";
import { phpLooseEquals } from "../ticket/record";
import type { PhpVars } from "./php";

/**
 * Informazioni dell'azienda (include/class.company.php): form dinamico di tipo "C" con una sola
 * form_entry (object_type 'C', object_id NULL). Company::getForm() usa l'entry esistente oppure ne
 * istanzia una nuova; updatePagesSettings la valida con il POST e la salva (saveAnswers: aggiorna
 * solo le risposte cambiate, senza toccare form_entry.updated). Nessuna tabella *__cdata.
 */
export interface CompanyForm {
  formId: number;
  fields: FieldDef[];
  entry: FormEntry | null;
  input: PhpVars;
  errors: Record<string, string>;
}

export async function loadCompanyForm(executor: DbOrTx): Promise<Omit<CompanyForm, "input" | "errors"> | null> {
  const row = await executor
    .selectFrom("form_entry as e")
    .innerJoin("form as f", "f.id", "e.form_id")
    .select(["e.id", "e.form_id", "e.sort"])
    .where("e.object_type", "=", "C")
    .orderBy("e.id")
    .executeTakeFirst();
  if (row) {
    const fields = await loadFormFields(executor, row.form_id);
    const vals = await executor.selectFrom("form_entry_values").select(["field_id", "value"]).where("entry_id", "=", row.id).execute();
    const byField = new Map(vals.map((v) => [v.field_id, v.value]));
    const answers = new Map(fields.map((f) => [f.id, { field: f, value: byField.get(f.id) ?? null, exists: byField.has(f.id) }]));
    return { formId: row.form_id, fields, entry: { id: row.id, form_id: row.form_id, form_type: "C", sort: row.sort, fields, answers } };
  }
  const form = await executor.selectFrom("form").select("id").where("type", "=", "C").orderBy("id").executeTakeFirst();
  if (!form) return null;
  return { formId: form.id, fields: await loadFormFields(executor, form.id), entry: null };
}

/** $company_form->setSource($_POST); $company_form->isValid() */
export async function validateCompanyForm(executor: DbOrTx, input: PhpVars): Promise<CompanyForm> {
  const form = await loadCompanyForm(executor);
  if (!form) return { formId: 0, fields: [], entry: null, input, errors: {} };
  const errors = validateInput(form.fields, input as Record<string, unknown>, () => true);
  return { ...form, input, errors };
}

/** $company_form->save() */
export async function saveCompanyForm(executor: DbOrTx, form: CompanyForm): Promise<void> {
  if (!form.formId) return;
  if (form.entry) {
    await saveEntryAnswers(executor, form.entry, 0, form.input as Record<string, unknown>);
    return;
  }
  // DynamicForm::instanciate(): nuova entry con le risposte
  const res = await executor
    .insertInto("form_entry")
    .values({ form_id: form.formId, object_type: "C", sort: 1, created: NOW, updated: NOW } as never)
    .executeTakeFirstOrThrow();
  const entryId = Number(res.insertId);
  for (const f of form.fields) {
    if (!hasAnswerRow(f)) continue;
    const db = toDatabase(f, parseInput(f, inputFor(form.input as Record<string, unknown>, f)));
    await executor.insertInto("form_entry_values").values({ entry_id: entryId, field_id: f.id, value: phpLooseEquals(null, db) ? null : db }).execute();
  }
}

/** Valori correnti del form azienda (per precompilare la pagina). */
export async function companyValues(executor: DbOrTx): Promise<{ fields: FieldDef[]; values: Record<string, string> }> {
  const form = await loadCompanyForm(executor);
  if (!form) return { fields: [], values: {} };
  const values: Record<string, string> = {};
  for (const f of form.fields) values[f.name || String(f.id)] = form.entry?.answers.get(f.id)?.value ?? "";
  return { fields: form.fields, values };
}
