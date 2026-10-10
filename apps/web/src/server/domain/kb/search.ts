import "server-only";

import { sql } from "kysely";

import { AttachmentType } from "@/lib/osticket/object-types";

import { db, table, type DbOrTx } from "../../db";
import { likeEscape } from "../../db/like";
import type { Agent } from "../staff/staff";
import { byName, fullName, loadCategoryTree } from "./category-tree";
import { visibilityOf, type KbVisibility } from "./common";
import { faqTopicMap, faqVisibleForTopics, loadHelpTopics, staffTopicIds } from "./topics";

/** Ricerca FAQ e filtri della pagina principale della KB lato agente (scp/kb.php, faq-categories.inc.php). */

interface KbFilterOption {
  id: number;
  name: string;
  faqCount: number;
}

/**
 * Menu "Categoria" e "Help topic" della ricerca (faq-categories.inc.php): categorie e topic con
 * almeno una FAQ; i topic sono limitati a quelli visibili all'agente (Staff::getTopicNames).
 */
export async function kbSearchFilters(agent: Agent, executor: DbOrTx = db()): Promise<{ total: number; categories: KbFilterOption[]; topics: KbFilterOption[] }> {
  const [tree, topicCounts, topics, allowed] = await Promise.all([
    loadCategoryTree(executor),
    executor
      .selectFrom("faq_topic as ft")
      .innerJoin("help_topic as ht", "ht.topic_id", "ft.topic_id")
      .select(["ht.topic_id", (eb) => eb.fn.count<number>("ft.faq_id").as("n")])
      .groupBy("ht.topic_id")
      .execute(),
    loadHelpTopics(executor),
    staffTopicIds(agent, executor),
  ]);
  const total = [...tree.faqCount.values()].reduce((a, b) => a + b, 0);
  const categories = [...tree.rows.values()]
    .filter((c) => (tree.faqCount.get(c.category_id) ?? 0) > 0)
    .map((c) => ({ id: c.category_id, name: fullName(tree, c.category_id), faqCount: tree.faqCount.get(c.category_id) ?? 0 }))
    .sort(byName);
  const topicOptions = topicCounts
    .filter((t) => Number(t.n) > 0 && (!allowed || allowed.has(t.topic_id)))
    .map((t) => ({ id: t.topic_id, name: topics.get(t.topic_id)?.name ?? "", faqCount: Number(t.n) }))
    .sort(byName);
  return { total, categories, topics: topicOptions };
}

export interface KbFaqListItem {
  id: number;
  question: string;
  visibility: KbVisibility;
  /** FAQ::isPublished(): ispublished != 0 e categoria pubblica */
  isPublished: boolean;
  attachmentCount: number;
  categoryId: number;
  category: string;
}

/**
 * Ricerca FAQ di scp/kb.php: testo su domanda, risposta, parole chiave, nome e descrizione della
 * categoria; filtri per categoria e help topic. Le FAQ sono poi filtrate per gli help topic visibili
 * all'agente come nella pagina categoria (osTicket non lo fa nella ricerca: qui il comportamento è
 * uniforme, così una FAQ nascosta nella categoria non ricompare cercandola).
 */
export async function searchFaqs(
  agent: Agent,
  params: { q?: string | null; categoryId?: number | null; topicId?: number | null },
  executor: DbOrTx = db(),
): Promise<KbFaqListItem[]> {
  const conds = [sql`1 = 1`];
  if (params.categoryId) conds.push(sql`f.category_id = ${params.categoryId}`);
  if (params.topicId) conds.push(sql`EXISTS (SELECT 1 FROM ${table("faq_topic")} ft WHERE ft.faq_id = f.faq_id AND ft.topic_id = ${params.topicId})`);
  const q = (params.q ?? "").trim();
  if (q) {
    const like = `%${likeEscape(q)}%`;
    conds.push(sql`(f.question LIKE ${like} OR f.answer LIKE ${like} OR f.keywords LIKE ${like} OR c.name LIKE ${like} OR c.description LIKE ${like})`);
  }
  const { rows } = await sql<{
    faq_id: number;
    question: string;
    ispublished: number;
    category_id: number;
    category: string | null;
    cat_public: number;
    attachments: number | string;
  }>`
    SELECT f.faq_id, f.question, f.ispublished, f.category_id, c.name AS category, c.ispublic AS cat_public,
      (SELECT COUNT(*) FROM ${table("attachment")} a WHERE a.type = ${sql.lit(AttachmentType.FAQ)} AND a.object_id = f.faq_id AND a.inline = 0) AS attachments
    FROM ${table("faq")} f
    JOIN ${table("faq_category")} c ON (c.category_id = f.category_id)
    WHERE ${sql.join(conds, sql` AND `)}
    ORDER BY f.question, f.faq_id`.execute(executor);
  const allowed = await staffTopicIds(agent, executor);
  const topicsByFaq = allowed ? await faqTopicMap(rows.map((r) => r.faq_id), executor) : new Map<number, number[]>();
  return rows
    .filter((r) => faqVisibleForTopics(topicsByFaq.get(r.faq_id) ?? [], allowed))
    .map((r) => ({
      id: r.faq_id,
      question: r.question,
      visibility: visibilityOf(r.ispublished),
      isPublished: r.ispublished !== 0 && r.cat_public !== 0,
      attachmentCount: Number(r.attachments),
      categoryId: r.category_id,
      category: r.category ?? "",
    }));
}
