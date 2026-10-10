import "server-only";

import { AttachmentType } from "@/lib/osticket/object-types";

import { coreConfig } from "../../config/config";
import { db, type DbOrTx } from "../../db";
import type { DbDateTime } from "../../db/schema.gen";
import type { Agent } from "../staff/staff";
import { ancestry, fullName, loadCategoryTree } from "./category-tree";
import { objectAttachments, visibilityOf, type KbAttachment, type KbVisibility } from "./common";
import { kbDisplayHtml } from "./html";
import { faqTopicMap, faqVisibleForTopics, loadHelpTopics, staffTopicIds } from "./topics";

/** Dettaglio di una FAQ lato agente, in sola lettura (scp/faq.php, include/staff/faq-view.inc.php) — doc 07 §2. */

/** La FAQ esiste ed è visibile all'agente nelle pagine KB (filtro per help topic). */
export async function faqVisibleToAgent(agent: Agent, faqId: number, executor: DbOrTx = db()): Promise<boolean> {
  const faq = await executor.selectFrom("faq").select("faq_id").where("faq_id", "=", faqId).executeTakeFirst();
  if (!faq) return false;
  const allowed = await staffTopicIds(agent, executor);
  if (!allowed) return true;
  const topics = await faqTopicMap([faqId], executor);
  return faqVisibleForTopics(topics.get(faqId) ?? [], allowed);
}

interface KbFaqDetail {
  id: number;
  question: string;
  answerHtml: string;
  keywords: string[];
  notesHtml: string;
  visibility: KbVisibility;
  isPublished: boolean;
  created: DbDateTime;
  updated: DbDateTime;
  category: { id: number; name: string; visibility: KbVisibility };
  path: { id: number; name: string }[];
  attachments: KbAttachment[];
  topics: { id: number; name: string }[];
}

/** Lingua di visualizzazione degli allegati (FAQ::getDisplayLang): lingua dell'agente o di sistema. */
async function displayLang(agent: Agent): Promise<string> {
  return agent.row.lang || (await coreConfig()).str("system_language") || "en_US";
}

/** Parole chiave (campo libero): separate da virgole se presenti, altrimenti da spazi; senza doppioni. */
function splitKeywords(value: string | null): string[] {
  const text = (value ?? "").trim();
  if (!text) return [];
  const parts = text.split(text.includes(",") ? /\s*[,;]\s*/ : /\s+/);
  return [...new Set(parts.map((k) => k.trim()).filter(Boolean))];
}

/** Dettaglio FAQ (faq-view.inc.php); null se inesistente o nascosta all'agente dal filtro per topic. */
export async function getFaq(agent: Agent, faqId: number, executor: DbOrTx = db()): Promise<KbFaqDetail | null> {
  if (!Number.isInteger(faqId) || faqId <= 0) return null;
  const row = await executor
    .selectFrom("faq as f")
    .innerJoin("faq_category as c", "c.category_id", "f.category_id")
    .select(["f.faq_id", "f.question", "f.answer", "f.keywords", "f.notes", "f.ispublished", "f.created", "f.updated", "c.category_id", "c.ispublic as cat_public"])
    .where("f.faq_id", "=", faqId)
    .executeTakeFirst();
  if (!row || !(await faqVisibleToAgent(agent, faqId, executor))) return null;

  const [tree, attachments, topicRows, topics, lang] = await Promise.all([
    loadCategoryTree(executor),
    objectAttachments(AttachmentType.FAQ, faqId, executor),
    executor.selectFrom("faq_topic").select("topic_id").where("faq_id", "=", faqId).execute(),
    loadHelpTopics(executor),
    displayLang(agent),
  ]);
  return {
    id: row.faq_id,
    question: row.question,
    answerHtml: kbDisplayHtml(row.answer),
    keywords: splitKeywords(row.keywords),
    notesHtml: kbDisplayHtml(row.notes),
    visibility: visibilityOf(row.ispublished),
    isPublished: row.ispublished !== 0 && row.cat_public !== 0,
    created: row.created,
    updated: row.updated,
    category: { id: row.category_id, name: fullName(tree, row.category_id), visibility: visibilityOf(row.cat_public) },
    path: ancestry(tree, row.category_id),
    // FAQ::getLocalAttachments(): non inline, senza lingua o nella lingua di visualizzazione
    attachments: attachments.filter((a) => !a.inline && (!a.lang || a.lang === lang)),
    topics: topicRows
      .map((t) => topics.get(t.topic_id))
      .filter((t) => t !== undefined)
      .map((t) => ({ id: t.id, name: t.name })),
  };
}
