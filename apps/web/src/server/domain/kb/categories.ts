import "server-only";

import { db, type DbOrTx } from "../../db";
import type { DbDateTime } from "../../db/schema.gen";
import type { Agent } from "../staff/staff";
import { ancestry, byName, fullName, loadCategoryTree, summary, type KbCategorySummary } from "./category-tree";
import { visibilityOf, type KbVisibility } from "./common";
import { kbDisplayHtml } from "./html";
import { searchFaqs, type KbFaqListItem } from "./search";

/**
 * Categorie della KB lato agente, in sola lettura — doc 07 §2. Port di scp/kb.php e dei template
 * include/staff/faq-categories.inc.php e faq-category.inc.php.
 * Le traduzioni (tabella translation) non sono gestite: si mostrano i testi originali.
 */

interface KbTopCategory extends KbCategorySummary {
  descriptionHtml: string;
  children: KbCategorySummary[];
}

/** Pagina principale della KB (senza ricerca): categorie di primo livello con i figli diretti. */
export async function listTopCategories(executor: DbOrTx = db()): Promise<KbTopCategory[]> {
  const tree = await loadCategoryTree(executor);
  return [...tree.rows.values()]
    .filter((c) => c.category_pid === null || !tree.rows.has(c.category_pid))
    .map((c) => ({
      ...summary(tree, c.category_id),
      descriptionHtml: kbDisplayHtml(c.description),
      children: (tree.children.get(c.category_id) ?? []).map((id) => summary(tree, id)),
    }))
    .sort(byName);
}

interface KbCategoryDetail {
  id: number;
  name: string;
  fullName: string;
  visibility: KbVisibility;
  updated: DbDateTime;
  descriptionHtml: string;
  notesHtml: string;
  /** dalla radice alla categoria stessa */
  path: { id: number; name: string }[];
  children: KbCategorySummary[];
  faqs: KbFaqListItem[];
  /** FAQ della categoria nascoste dal filtro per help topic */
  hiddenFaqs: number;
}

/** Pagina di una categoria (faq-category.inc.php): FAQ filtrate per gli help topic dell'agente. */
export async function getCategory(agent: Agent, categoryId: number, executor: DbOrTx = db()): Promise<KbCategoryDetail | null> {
  if (!Number.isInteger(categoryId) || categoryId <= 0) return null;
  const tree = await loadCategoryTree(executor);
  const row = tree.rows.get(categoryId);
  if (!row) return null;
  const faqs = await searchFaqs(agent, { categoryId }, executor);
  return {
    id: categoryId,
    name: row.name ?? "",
    fullName: fullName(tree, categoryId),
    visibility: visibilityOf(row.ispublic),
    updated: row.updated,
    descriptionHtml: kbDisplayHtml(row.description),
    notesHtml: kbDisplayHtml(row.notes),
    path: ancestry(tree, categoryId),
    children: (tree.children.get(categoryId) ?? []).map((id) => summary(tree, id)),
    faqs,
    hiddenFaqs: (tree.faqCount.get(categoryId) ?? 0) - faqs.length,
  };
}
