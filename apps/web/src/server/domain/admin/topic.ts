import "server-only";

import { sql } from "kysely";

import { table, type DbOrTx } from "../../db";
import { stripTags } from "../../format/html";
import { phpJsonEncode } from "../../format/php-json";
import { sanitizeText } from "../../format/text";
import { adminDefaults, exists, idOf, type MassResult, type SaveResult } from "./common";
import { ConfigWriter } from "./config-write";
import { DeptFlag } from "./dept";
import { FILTER_REFS, filterActionsReferencing } from "./filters";
import { OrmRow, SQL_NOW, setFlag } from "./orm";
import { hasHash, isNumeric, isset, list, phpLooseEquals, str, truthy, type PhpVal, type PhpVars } from "./php";

/**
 * Help topic: scp/helptopics.php → Topic::update / Topic::delete / mass_process (include/class.topic.php),
 * form associati (help_topic_form, Topic::updateForms) e ordinamento (Topic::updateSortOrder).
 */
export const TopicFlag = { CUSTOM_NUMBERS: 0x0001, ACTIVE: 0x0002, ARCHIVED: 0x0004 } as const;

const TOPIC_OPTS = { touchUpdated: true };

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
    topics.set(r.topic_id, { pid: r.topic_pid, public: !!r.ispublic, disabled: !((r.flags ?? 0) & TopicFlag.ACTIVE), topic: r.topic, deptId: r.dept_id });
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
  const values = sql.join(sorted.map((t, idx) => sql`(${t.id}, ${idx + 1})`));
  await sql`INSERT INTO ${table("help_topic")} (topic_id, \`sort\`) VALUES ${values} ON DUPLICATE KEY UPDATE \`sort\` = VALUES(\`sort\`)`.execute(executor);
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
  if (dept && !((dept.flags ?? 0) & DeptFlag.ACTIVE)) errors.dept_id = "inactive";
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
  setFlag(topic, TopicFlag.CUSTOM_NUMBERS, truthy(vars["custom-numbers"]));
  topic.set("noautoresp", isset(vars, "noautoresp") ? 1 : 0);
  topic.set("notes", sanitizeText(str(vars.notes)));
  // FilterAction::setFilterFlags(FLAG_INACTIVE_HT): nessuna scrittura (vedi filters.ts)
  switch (str(vars.status)) {
    case "active":
      setFlag(topic, TopicFlag.ACTIVE, true);
      setFlag(topic, TopicFlag.ARCHIVED, false);
      break;
    case "disabled":
      setFlag(topic, TopicFlag.ACTIVE, false);
      setFlag(topic, TopicFlag.ARCHIVED, false);
      break;
    case "archived":
      setFlag(topic, TopicFlag.ACTIVE, false);
      setFlag(topic, TopicFlag.ARCHIVED, true);
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
    } else if (F.type !== "T") {
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

/**
 * Topic::delete(): non il topic predefinito; i figli tornano al primo livello, si eliminano le
 * associazioni con le FAQ, i ticket perdono il topic. Le righe help_topic_form restano (come nel PHP).
 */
async function deleteTopic(executor: DbOrTx, topicId: number): Promise<{ ok: boolean; error?: string }> {
  const { topicId: def } = await adminDefaults(executor);
  if (topicId === def) return { ok: false, error: "default" };
  if (await filterActionsReferencing(executor, FILTER_REFS.topic, topicId)) return { ok: false, error: "filter" };
  const res = await executor.deleteFrom("help_topic").where("topic_id", "=", topicId).executeTakeFirst();
  if (Number(res.numDeletedRows)) {
    await executor.updateTable("help_topic").set({ topic_pid: 0 }).where("topic_pid", "=", topicId).execute();
    await executor.deleteFrom("faq_topic").where("topic_id", "=", topicId).execute();
    await executor.updateTable("ticket").set({ topic_id: 0 }).where("topic_id", "=", topicId).execute();
  }
  return { ok: true };
}

export type TopicMassAction = "enable" | "disable" | "archive" | "delete" | "sort";

/** scp/helptopics.php mass_process (con `post` per l'ordinamento: help_topic_sort_mode, sort-<id>). */
export async function massTopics(executor: DbOrTx, action: TopicMassAction, ids: number[], post: PhpVars = {}): Promise<MassResult> {
  if (action !== "sort" && !ids.length) return { ok: false, num: 0, error: "select" };
  const { topicId: def } = await adminDefaults(executor);
  const count = ids.length;
  const snapshot = await helpTopicsSnapshot(executor);
  const active = snapshot.filter((t) => !t.disabled).map((t) => t.id);
  const all = snapshot.length;
  const diff = ids.filter((i) => active.includes(i));
  const blocked = count >= all || diff.length === active.length;
  let num = 0;
  const flagAll = async (only: number[], arch: boolean, act: boolean) => {
    const rows = await executor.selectFrom("help_topic").selectAll().where("topic_id", "in", only).execute();
    for (const r of rows) {
      const t = OrmRow.from("help_topic", "topic_id", r, TOPIC_OPTS);
      setFlag(t, TopicFlag.ARCHIVED, arch);
      setFlag(t, TopicFlag.ACTIVE, act);
      await t.save(executor);
      num++;
    }
  };
  switch (action) {
    case "enable":
      await flagAll(ids, false, true);
      return { ok: num > 0, num };
    case "disable":
    case "archive":
      if (blocked) return { ok: false, num: 0, error: "one_active" };
      await flagAll(
        ids.filter((i) => i !== def),
        action === "archive",
        false,
      );
      return { ok: num > 0, num };
    case "delete": {
      if (blocked) return { ok: false, num: 0, error: "one_active" };
      const existing = await executor.selectFrom("help_topic").select("topic_id").where("topic_id", "in", ids).execute();
      for (const t of existing) {
        if (t.topic_id === def) continue;
        const r = await deleteTopic(executor, t.topic_id);
        if (r.error === "filter") return { ok: num > 0, num, error: "filter" };
        if (r.ok) num++;
      }
      return { ok: num > 0, num };
    }
    case "sort": {
      const mode = str(post.help_topic_sort_mode);
      if (mode !== "a" && mode !== "m") return { ok: false, num: 0, error: "sort_mode" };
      const cfg = await ConfigWriter.load(executor, "core");
      // Config::update di una chiave nuova crea la riga ma non la aggiunge alla cache dell'oggetto:
      // getTopicSortMode() nella stessa richiesta restituisce ancora il default 'a' (stranezza
      // replicata: al primo passaggio a "manuale" l'ordine inviato non viene salvato)
      const existed = cfg.has("help_topic_sort_mode");
      await cfg.update(executor, "help_topic_sort_mode", mode);
      if ((existed ? mode : "a") === "m") {
        for (const [k, v] of Object.entries(post)) {
          if (!k.startsWith("sort-") || !isNumeric(v)) continue;
          const tid = idOf(k.slice(5));
          const r = tid ? await executor.selectFrom("help_topic").selectAll().where("topic_id", "=", tid).executeTakeFirst() : undefined;
          if (!r) continue;
          // Topic::setSortOrder: salva solo se cambia
          if (phpLooseEquals(v as never, r.sort)) continue;
          const t = OrmRow.from("help_topic", "topic_id", r, TOPIC_OPTS);
          t.set("sort", str(v));
          await t.save(executor);
          num++;
        }
      }
      return { ok: true, num };
    }
  }
}
