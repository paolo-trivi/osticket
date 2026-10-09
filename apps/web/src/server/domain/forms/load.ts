import "server-only";

import type { ConfigNamespace } from "../../config/config";
import type { DbOrTx } from "../../db";
import { phpJsonDecode } from "../../format/php-json";
import { fieldChoices, fieldConfig, type FieldDef, type FormAudience } from "./fields";

/**
 * Lettura dei form dinamici dal DB (DynamicForm / DynamicFormField) con i campi ordinati per `sort`
 * e le scelte risolte (priorità, reparti, liste personalizzate).
 */
export interface FormDef {
  id: number;
  type: string;
  title: string;
  instructions: string;
  fields: FieldDef[];
}

/** Flag di Dept usati per le scelte del campo reparto */
const DEPT_ACTIVE = 0x0004;

async function resolveChoices(executor: DbOrTx, f: FieldDef, audience: FormAudience): Promise<void> {
  if (f.type === "choices") f.choices = fieldChoices(f);
  else if (f.type === "priority") {
    const rows = await executor.selectFrom("ticket_priority").select(["priority_id", "priority_desc"]).orderBy("priority_urgency", "desc").execute();
    f.choices = Object.fromEntries(rows.map((r) => [String(r.priority_id), r.priority_desc]));
  } else if (f.type === "department") {
    let q = executor.selectFrom("department").select(["id", "name", "flags", "ispublic"]).orderBy("name");
    if (audience === "client") q = q.where("ispublic", "=", 1);
    const rows = await q.execute();
    f.choices = Object.fromEntries(rows.filter((r) => r.flags & DEPT_ACTIVE).map((r) => [String(r.id), r.name]));
  } else if (f.type.startsWith("list-")) {
    const listId = Number(f.type.slice(5));
    const list = await executor.selectFrom("list").select(["id", "sort_mode", "type"]).where("id", "=", listId).executeTakeFirst();
    if (!list) {
      f.choices = {};
      return;
    }
    const rows = await executor.selectFrom("list_items").select(["id", "value", "sort", "status"]).where("list_id", "=", listId).execute();
    // DynamicListItem::ENABLED = 1
    const enabled = rows.filter((r) => r.status & 1);
    if (list.sort_mode === "Alpha") enabled.sort((a, b) => a.value.localeCompare(b.value));
    else if (list.sort_mode === "-Alpha") enabled.sort((a, b) => b.value.localeCompare(a.value));
    else enabled.sort((a, b) => a.sort - b.sort);
    f.choices = Object.fromEntries(enabled.map((r) => [String(r.id), r.value]));
  }
}

export async function loadFormDef(
  executor: DbOrTx,
  cfg: ConfigNamespace,
  where: { id: number } | { type: string },
  audience: FormAudience = "staff",
): Promise<FormDef | null> {
  let q = executor.selectFrom("form").select(["id", "type", "title", "instructions"]);
  q = "id" in where ? q.where("id", "=", where.id) : q.where("type", "=", where.type).orderBy("id");
  const form = await q.executeTakeFirst();
  if (!form) return null;
  const rows = await executor
    .selectFrom("form_field")
    .select(["id", "form_id", "type", "label", "name", "hint", "flags", "sort", "configuration"])
    .where("form_id", "=", form.id)
    .orderBy("sort")
    .orderBy("id")
    .execute();
  const fields: FieldDef[] = rows.map((r) => ({
    id: r.id,
    formId: r.form_id,
    type: r.type,
    label: r.label,
    name: r.name,
    hint: r.hint ?? "",
    flags: r.flags ?? 0,
    sort: r.sort,
    config: fieldConfig(r.type, r.configuration, cfg),
  }));
  for (const f of fields) await resolveChoices(executor, f, audience);
  return { id: form.id, type: form.type, title: form.title ?? "", instructions: form.instructions ?? "", fields };
}

interface TopicFormDef extends FormDef {
  /** campi disattivati per il topic (help_topic_form.extra.disable) */
  disabled: number[];
}

/** Topic::getForms(): form collegati al topic in ordine, con i campi disattivati. */
export async function loadTopicForms(executor: DbOrTx, cfg: ConfigNamespace, topicId: number, audience: FormAudience = "staff"): Promise<TopicFormDef[]> {
  if (!topicId) return [];
  const links = await executor
    .selectFrom("help_topic_form")
    .select(["form_id", "sort", "extra"])
    .where("topic_id", "=", topicId)
    .orderBy("sort")
    .orderBy("id")
    .execute();
  const out: TopicFormDef[] = [];
  for (const l of links) {
    const form = await loadFormDef(executor, cfg, { id: l.form_id }, audience);
    if (!form) continue;
    const disabled = (phpJsonDecode<{ disable?: unknown[] }>(l.extra, {}).disable ?? []).map(Number);
    for (const f of form.fields) if (disabled.includes(f.id)) f.disabled = true;
    out.push({ ...form, disabled });
  }
  return out;
}
