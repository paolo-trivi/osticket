import "server-only";

import { DynamicFormField, Topic } from "@/lib/osticket/flags";
import { FormType } from "@/lib/osticket/object-types";

import type { ConfigNamespace } from "../../config/config";
import type { DbOrTx } from "../../db";
import { phpJsonEncode } from "../../format/php-json";
import { FormInstance } from "../forms/entry";
import { hasFlag, type DateFormatOptions, type FormAudience } from "../forms/fields";
import { loadTopicForms, type FormDef } from "../forms/load";
import type { TicketVars } from "../filter/ticket-filter";

/**
 * Argomento (help topic) del ticket in creazione (include/class.topic.php): lettura del topic e dei suoi
 * default, nome completo, stato attivo, form aggiuntivi con i campi disattivati e priorità selezionabile.
 */

export interface TopicRow {
  topic_id: number;
  topic_pid: number;
  flags: number;
  noautoresp: number;
  sequence_id: number;
  number_format: string | null;
  priority_id: number;
  dept_id: number;
  staff_id: number;
  team_id: number;
  sla_id: number;
  status_id: number;
  topic: string;
}

export async function loadTopic(executor: DbOrTx, id: number): Promise<TopicRow | null> {
  if (!id) return null;
  const t = await executor
    .selectFrom("help_topic")
    .select(["topic_id", "topic_pid", "flags", "noautoresp", "sequence_id", "number_format", "priority_id", "dept_id", "staff_id", "team_id", "sla_id", "status_id", "topic"])
    .where("topic_id", "=", id)
    .executeTakeFirst();
  return t ? { ...t, flags: t.flags ?? 0 } : null;
}

/** Topic::getFullName: percorso "Padre / Figlio" */
export async function topicFullName(executor: DbOrTx, t: TopicRow): Promise<string> {
  const all = await executor.selectFrom("help_topic").select(["topic_id", "topic_pid", "topic"]).execute();
  const byId = new Map(all.map((r) => [r.topic_id, r]));
  const parts: string[] = [];
  const seen = new Set<number>();
  let cur: { topic_id: number; topic_pid: number; topic: string } | undefined = byId.get(t.topic_id);
  while (cur && !seen.has(cur.topic_id)) {
    seen.add(cur.topic_id);
    parts.unshift(cur.topic);
    cur = cur.topic_pid ? byId.get(cur.topic_pid) : undefined;
  }
  return parts.join(" / ") || t.topic;
}

export async function topicIsActive(executor: DbOrTx, id: number): Promise<boolean> {
  const t = await executor.selectFrom("help_topic").select("flags").where("topic_id", "=", id).executeTakeFirst();
  return !!t && ((t.flags ?? 0) & Topic.ACTIVE) !== 0;
}

/**
 * Form del topic scelto (Topic::getForms): il form ticket del topic disattiva i suoi campi nel form del
 * ticket e ne fissa posizione ed `extra`; gli altri form diventano istanze aggiuntive. Topic inesistente → [].
 */
export async function topicFormInstances(
  executor: DbOrTx,
  cfg: ConfigNamespace,
  topicId: number,
  audience: FormAudience,
  form: FormInstance,
  sourceFor: (def: FormDef) => TicketVars,
  dates: DateFormatOptions,
): Promise<FormInstance[]> {
  const out: FormInstance[] = [];
  const t = await loadTopic(executor, topicId);
  if (!t) return out;
  const tforms = await loadTopicForms(executor, cfg, t.topic_id, audience);
  tforms.forEach((F, idx) => {
    const disabled = F.fields.filter((f) => f.disabled && hasFlag(f, DynamicFormField.ENABLED)).map((f) => f.id);
    const extra = phpJsonEncode({ disable: disabled });
    if (F.type === FormType.TICKET) {
      for (const f of form.fields) if (disabled.includes(f.id)) f.disabled = true;
      form.sort = idx;
      form.extra = extra;
    } else out.push(new FormInstance(F, sourceFor(F), idx, extra, { dates }));
  });
  return out;
}

/** Priorità come risposta del campo "priority" (id e descrizione), null se inesistente */
export async function prioritySelection(executor: DbOrTx, id: number): Promise<{ id: number; label: string } | null> {
  if (!id) return null;
  const p = await executor.selectFrom("ticket_priority").select(["priority_id", "priority_desc"]).where("priority_id", "=", id).executeTakeFirst();
  return p ? { id: p.priority_id, label: p.priority_desc } : null;
}
