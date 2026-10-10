import "server-only";

import { sql } from "kysely";

import { Dept, Topic } from "@/lib/osticket/flags";
import { FormType } from "@/lib/osticket/object-types";

import type { DbOrTx } from "../../db";
import { stripTags } from "../../format/html";
import { phpJsonEncode } from "../../format/php-json";
import { sanitizeText } from "../../format/text";
import { isNumeric, isset, list, phpLooseEquals, str, truthy, type PhpVal, type PhpVars } from "../../php/values";
import { adminDefaults, exists, hasHash, idOf, type SaveResult } from "./common";
import { ConfigWriter } from "./config-write";
import { OrmRow, SQL_NOW, setFlag } from "./orm";

/**
 * Help topic: scp/helptopics.php → Topic::update (include/class.topic.php), form associati
 * (help_topic_form, Topic::updateForms) e ordinamento (Topic::updateSortOrder). Eliminazione e
 * azioni di massa sono in topic-mass.ts.
 */

export const TOPIC_OPTS = { touchUpdated: true };

interface TopicInfo {
  id: number;
  pid: number;
  public: boolean;
  disabled: boolean;
  topic: string;
  deptId: number;
  /** nome completo "Padre / Figlio" */
  name: string;
}

/**
 * Topic::getHelpTopics(): elenco nell'ordine di `sort` con i nomi completi; il flag "disabled" del
 * padre si propaga solo dal secondo livello in su (il PHP controlla il padre dell'iterazione
 * precedente: stranezza replicata).
 */
export async function helpTopicsSnapshot(executor: DbOrTx): Promise<TopicInfo[]> {
  const rows = await executor.selectFrom("help_topic").select(["topic_id", "topic_pid", "ispublic", "flags", "topic", "dept_id"]).orderBy("sort").execute();
  const topics = new Map<number, { pid: number; public: boolean; disabled: boolean; topic: string; deptId: number }>();
  for (const r of rows)
    topics.set(r.topic_id, { pid: r.topic_pid, public: !!r.ispublic, disabled: !((r.flags ?? 0) & Topic.ACTIVE), topic: r.topic, deptId: r.dept_id });
  const out: TopicInfo[] = [];
  for (const [id, base] of topics) {
    let info = base;
    let name = info.topic;
    const loop = new Set([id]);
    let parent: typeof info | null = null;
    let disabled = base.disabled;
    while (info.pid && topics.get(info.pid)) {
      const pid = info.pid;
      info = topics.get(pid)!;
      name = `${info.topic} / ${name}`;
      if (parent && parent.disabled) disabled = true;
      if (loop.has(info.pid)) break;
      loop.add(info.pid);
      parent = info;
    }
    out.push({ id, pid: base.pid, public: base.public, disabled, topic: base.topic, deptId: base.deptId, name });
  }
  return out;
}

/** Internationalization::sortKeyedList: Collator della lingua principale (forza TERTIARY). */
export function sortByName<T extends { name: string }>(items: T[], lang: string): T[] {
  const coll = new Intl.Collator(lang.replace("_", "-") || "en-US", { sensitivity: "variant" });
  return [...items].sort((a, b) => coll.compare(a.name, b.name));
}

/** Topic::updateSortOrder() con l'elenco dei nomi indicato (vedi nota in saveTopic). */
async function updateSortOrder(executor: DbOrTx, names: TopicInfo[], lang: string): Promise<void> {
  const sorted = sortByName(names, lang);
  if (!sorted.length) return;
  // INSERT … ON DUPLICATE KEY UPDATE `sort` = VALUES(`sort`) con il query builder (annullabile: changes/)
  await executor
    .insertInto("help_topic")
    .values(sorted.map((t, idx) => ({ topic_id: t.id, sort: idx + 1 })) as never)
    .onDuplicateKeyUpdate({ sort: sql`VALUES(\`sort\`)` } as never)
    .execute();
}

/** Topic::getIdByName($name, $pid) */
async function topicIdByName(executor: DbOrTx, name: string, pid: PhpVal): Promise<number> {
  let q = executor.selectFrom("help_topic").select("topic_id").where("topic", "=", name);
  q = pid === undefined || pid === null ? q.where(sql<boolean>`topic_pid IS NULL`) : q.where(sql<boolean>`topic_pid = ${str(pid)}`);
  return (await q.executeTakeFirst())?.topic_id ?? 0;
}

/** Topic::update($vars, $errors) — creazione se topicId è null (Topic::create()). */
export async function saveTopic(executor: DbOrTx, topicId: number | null, input: PhpVars): Promise<SaveResult> {
  const errors: Record<string, string> = {};
  const defaults = await adminDefaults(executor);
  const lang = (await ConfigWriter.load(executor, "core")).get("system_language") ?? "en_US";
  let topic: OrmRow;
  if (topicId) {
    const row = await OrmRow.load(executor, "help_topic", "topic_id", { topic_id: topicId }, TOPIC_OPTS);
    if (!row) return { ok: false, errors: { err: "not_found" } };
    topic = row;
  } else {
    topic = OrmRow.create("help_topic", "topic_id", TOPIC_OPTS);
    topic.set("created", SQL_NOW);
  }
  const vars: PhpVars = { ...input, topic: stripTags(str(input.topic).trim()) };
  const id = topicId;

  if (id && !phpLooseEquals(id, vars.id as never)) errors.err = "internal";
  if (!truthy(vars.topic)) errors.topic = "required";
  else if (Buffer.byteLength(str(vars.topic), "utf8") < 5) errors.topic = "too_short";
  else {
    const tid = await topicIdByName(executor, str(vars.topic), vars.topic_pid);
    if (tid && (!id || tid !== id)) errors.topic = "exists";
  }
  const deptId = idOf(vars.dept_id);
  const dept = deptId ? await executor.selectFrom("department").select("flags").where("id", "=", deptId).executeTakeFirst() : undefined;
  if (dept && !((dept.flags ?? 0) & Dept.ACTIVE)) errors.dept_id = "inactive";
  if (!isNumeric(vars.dept_id)) errors.dept_id = "required";
  if (truthy(vars["custom-numbers"]) && !hasHash(vars.number_format)) errors.number_format = "hash";

  // Elenco dei topic letto PRIMA del salvataggio: getHelpTopics() lo tiene in una cache statica che
  // updateSortOrder() riusa (i nomi nuovi o cambiati non contano per l'ordinamento in questa richiesta)
  const snapshot = await helpTopicsSnapshot(executor);
  const publicTopics = snapshot.filter((t) => t.public && !t.disabled);
  if (publicTopics.length === 1 && id && publicTopics[0].id === id && phpLooseEquals(vars.ispublic as never, 0)) errors.ispublic = "one_public";
  const activeTopics = snapshot.filter((t) => !t.disabled);
  if (activeTopics.length === 1 && id && activeTopics[0].id === id && str(vars.status) !== "active") errors.status = "one_active";
  if (Object.keys(errors).length) return { ok: false, errors };

  topic.set("topic", str(vars.topic));
  topic.set("topic_pid", truthy(vars.topic_pid) ? str(vars.topic_pid) : 0);
  topic.set("dept_id", str(vars.dept_id));
  topic.set("priority_id", truthy(vars.priority_id) ? str(vars.priority_id) : 0);
  topic.set("status_id", truthy(vars.status_id) ? str(vars.status_id) : 0);
  topic.set("sla_id", truthy(vars.sla_id) ? str(vars.sla_id) : 0);
  topic.set("page_id", truthy(vars.page_id) ? str(vars.page_id) : 0);
  topic.set("ispublic", vars.ispublic === undefined || vars.ispublic === null ? null : str(vars.ispublic));
  topic.set("sequence_id", truthy(vars["custom-numbers"]) ? (vars.sequence_id === undefined ? null : str(vars.sequence_id)) : 0);
  topic.set("number_format", vars.number_format === undefined || vars.number_format === null ? null : str(vars.number_format));
  setFlag(topic, Topic.CUSTOM_NUMBERS, truthy(vars["custom-numbers"]));
  topic.set("noautoresp", isset(vars, "noautoresp") ? 1 : 0);
  topic.set("notes", sanitizeText(str(vars.notes)));
  // FilterAction::setFilterFlags(FLAG_INACTIVE_HT): nessuna scrittura (vedi filters.ts)
  switch (str(vars.status)) {
    case "active":
      setFlag(topic, Topic.ACTIVE, true);
      setFlag(topic, Topic.ARCHIVED, false);
      break;
    case "disabled":
      setFlag(topic, Topic.ACTIVE, false);
      setFlag(topic, Topic.ARCHIVED, false);
      break;
    case "archived":
      setFlag(topic, Topic.ACTIVE, false);
      setFlag(topic, Topic.ARCHIVED, true);
      break;
  }
  // assegnazione automatica: "s<id>" agente, "t<id>" team
  const assign = str(vars.assign);
  if (truthy(vars.assign) && assign[0] === "s") {
    topic.set("team_id", 0);
    topic.set("staff_id", assign.replace(/[^0-9]/g, ""));
  } else if (truthy(vars.assign) && assign[0] === "t") {
    topic.set("staff_id", 0);
    topic.set("team_id", assign.replace(/[^0-9]/g, ""));
  } else {
    topic.set("staff_id", 0);
    topic.set("team_id", 0);
  }

  if (topic.isNew) {
    const parentId = idOf(topic.get("topic_pid") as PhpVal);
    const parent = parentId ? await executor.selectFrom("help_topic").select("sort").where("topic_id", "=", parentId).executeTakeFirst() : undefined;
    if (parent) topic.set("sort", (parent.sort || 0) + 1);
  }
  await topic.save(executor);
  const newId = topic.num("topic_id");
  if (defaults.topicSortMode === "a") await updateSortOrder(executor, snapshot, lang);
  await updateForms(executor, newId, vars);
  return { ok: true, id: newId, errors: {} };
}

/** Topic::updateForms($vars): form associati (ordine, campi disabilitati, aggiunte e rimozioni). */
async function updateForms(executor: DbOrTx, topicId: number, vars: PhpVars): Promise<void> {
  const fields = Array.isArray(vars.fields) && vars.fields.length ? vars.fields : null;
  const findDisabled = async (formId: number): Promise<number[]> => {
    const rows = await executor.selectFrom("form_field").select("id").where("form_id", "=", formId).orderBy("sort").orderBy("id").execute();
    const disabled: number[] = [];
    for (const r of rows) if (fields && !fields.some((f) => phpLooseEquals(f as never, r.id))) disabled.push(r.id);
    return disabled;
  };
  if (!Array.isArray(vars.forms)) return;
  // array PHP con chiavi numeriche: le chiavi restano quelle originali dopo unset()
  const formIds = new Map<number, PhpVal>(list(vars.forms).map((v, i) => [i, v]));
  const current: number[] = [];
  const existing = await executor
    .selectFrom("help_topic_form as tf")
    .innerJoin("form as f", "f.id", "tf.form_id")
    .select(["tf.id", "tf.form_id", "tf.sort", "tf.extra", "f.type"])
    .where("tf.topic_id", "=", topicId)
    .orderBy("tf.sort")
    .execute();
  for (const F of existing) {
    const idx = [...formIds.entries()].find(([, v]) => phpLooseEquals(v as never, F.form_id))?.[0];
    if (idx !== undefined) {
      current.push(F.form_id);
      const row = OrmRow.from("help_topic_form", "id", F);
      row.set("sort", idx + 1);
      row.set("extra", phpJsonEncode({ disable: await findDisabled(F.form_id) }));
      await row.save(executor);
      formIds.delete(idx);
    } else if (F.type !== FormType.TICKET) {
      await executor.deleteFrom("help_topic_form").where("id", "=", F.id).execute();
    }
  }
  for (const [sort, fid] of formIds) {
    const formId = idOf(fid);
    if (!formId || !(await exists(executor, "form", formId))) continue;
    if (current.includes(formId)) continue;
    await executor
      .insertInto("help_topic_form")
      .values({ topic_id: topicId, form_id: formId, sort: sort + 1, extra: phpJsonEncode({ disable: await findDisabled(formId) }) })
      .execute();
  }
}
