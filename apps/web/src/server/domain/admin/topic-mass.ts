import "server-only";

import { Topic } from "@/lib/osticket/flags";

import type { DbOrTx } from "../../db";
import { isNumeric, phpLooseEquals, str, type PhpVars } from "../../php/values";
import { adminDefaults, idOf, type MassResult } from "./common";
import { ConfigWriter } from "./config-write";
import { FILTER_REFS, filterActionsReferencing } from "./filters";
import { OrmRow, setFlag } from "./orm";
import { helpTopicsSnapshot, TOPIC_OPTS } from "./topic";

/** Eliminazione e azioni di massa sugli help topic: Topic::delete e scp/helptopics.php mass_process. */

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
      setFlag(t, Topic.ARCHIVED, arch);
      setFlag(t, Topic.ACTIVE, act);
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
