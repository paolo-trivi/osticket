import "server-only";

import { Topic } from "@/lib/osticket/flags";

import { db, type DbOrTx } from "../../db";
import { GlobalPerm, type Agent } from "../staff/staff";
import { visibleTopicIds, type HelpTopicInfo } from "./topic-filter";

export { faqVisibleForTopics,   } from "./topic-filter";

/**
 * Topic::getHelpTopics(): tutti i topic in ordine `sort` con il nome completo "Padre / Figlio".
 * Il flag "disabilitato" si propaga come nel PHP (include/class.topic.php:360): il padre viene
 * controllato solo dal secondo livello in su, quindi il figlio di un topic di primo livello
 * disattivato resta attivo.
 */
export async function loadHelpTopics(executor: DbOrTx = db()): Promise<Map<number, HelpTopicInfo>> {
  const rows = await executor
    .selectFrom("help_topic")
    .select(["topic_id", "topic_pid", "ispublic", "flags", "topic", "dept_id"])
    .orderBy("sort")
    .execute();
  const topics = new Map<number, HelpTopicInfo>();
  for (const r of rows) {
    topics.set(r.topic_id, {
      id: r.topic_id,
      pid: r.topic_pid,
      isPublic: !!r.ispublic,
      disabled: (Number(r.flags ?? 0) & Topic.ACTIVE) === 0,
      name: r.topic,
      deptId: r.dept_id,
    });
  }
  const names = new Map<number, string>();
  const cascade = new Set<number>();
  for (const [id, base] of topics) {
    let name = base.name;
    const loop = new Set<number>([id]);
    let info: HelpTopicInfo | undefined = base;
    let parent: HelpTopicInfo | undefined;
    while (info && info.pid && (info = topics.get(info.pid))) {
      name = `${info.name} / ${name}`;
      if (parent?.disabled) cascade.add(id);
      if (loop.has(info.pid)) break;
      loop.add(info.pid);
      parent = info;
    }
    names.set(id, name);
  }
  for (const [id, t] of topics) {
    t.name = names.get(id) ?? t.name;
    if (cascade.has(id)) t.disabled = true;
  }
  return topics;
}

/**
 * Staff::getTopicNames(false) per il filtro FAQ delle pagine KB (faq-category.inc.php):
 * null quando il PHP non filtra (agente con visibility.departments), altrimenti gli id dei topic
 * attivi visibili all'agente in base ai suoi reparti.
 */
export async function staffTopicIds(agent: Agent, executor: DbOrTx = db()): Promise<Set<number> | null> {
  if (agent.hasGlobalPerm(GlobalPerm.VISIBILITY_DEPTS)) return null;
  return visibleTopicIds(await loadHelpTopics(executor), agent.deptIds);
}

/** Topic esistenti collegati a ciascuna FAQ (faq_topic). */
export async function faqTopicMap(faqIds: readonly number[], executor: DbOrTx = db()): Promise<Map<number, number[]>> {
  const out = new Map<number, number[]>();
  if (!faqIds.length) return out;
  const rows = await executor
    .selectFrom("faq_topic as ft")
    .innerJoin("help_topic as ht", "ht.topic_id", "ft.topic_id")
    .select(["ft.faq_id", "ft.topic_id"])
    .where("ft.faq_id", "in", [...faqIds])
    .execute();
  for (const r of rows) out.set(r.faq_id, [...(out.get(r.faq_id) ?? []), r.topic_id]);
  return out;
}
