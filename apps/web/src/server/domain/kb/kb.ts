import "server-only";

import { sql } from "kysely";

import { AttachmentType } from "@/lib/osticket/object-types";

import { coreConfig } from "../../config/config";
import { db, table, type DbOrTx } from "../../db";
import { likeEscape } from "../../db/like";
import type { DbDateTime } from "../../db/schema.gen";
import { htmlToPlain } from "../../mail/mailer";
import { GlobalPerm, type Agent } from "../staff/staff";
import { kbDisplayHtml } from "./html";
import { faqTopicMap, faqVisibleForTopics, loadHelpTopics, staffTopicIds } from "./topics";

/**
 * Knowledge base (FAQ, categorie) e risposte predefinite lato agente, in sola lettura — doc 07 §2–3.
 * Port di scp/kb.php, scp/faq.php, scp/canned.php e dei template include/staff/faq-categories.inc.php,
 * faq-category.inc.php, faq-view.inc.php, cannedresponses.inc.php, cannedresponse.inc.php.
 * Le traduzioni (tabella translation) non sono gestite: si mostrano i testi originali.
 */

/** Category::VISIBILITY_* e FAQ::VISIBILITY_*: 0 interna/privata, 1 pubblica, 2 in evidenza */
type KbVisibility = 0 | 1 | 2;
const visibilityOf = (v: number | null | undefined): KbVisibility => (v === 1 || v === 2 ? v : 0);

// ---------------------------------------------------------------------------------------------
// Allegati di oggetti KB (attachment.type 'F' FAQ, 'C' risposta predefinita)

interface KbAttachment {
  id: number;
  name: string;
  size: number;
  key: string;
  inline: boolean;
  lang: string | null;
}

async function objectAttachments(type: "F" | "C", objectId: number, executor: DbOrTx): Promise<KbAttachment[]> {
  const rows = await executor
    .selectFrom("attachment as a")
    .innerJoin("file as f", "f.id", "a.file_id")
    .select(["a.id", "a.name", "a.inline", "a.lang", "f.name as fname", "f.size", "f.key"])
    .where("a.type", "=", type)
    .where("a.object_id", "=", objectId)
    .orderBy("a.id")
    .execute();
  return rows.map((r) => ({ id: r.id, name: r.name || r.fname, size: Number(r.size), key: r.key, inline: !!r.inline, lang: r.lang }));
}

// ---------------------------------------------------------------------------------------------
// Albero delle categorie

interface CategoryRow {
  category_id: number;
  category_pid: number | null;
  ispublic: number;
  name: string | null;
  description: string;
  notes: string;
  created: DbDateTime;
  updated: DbDateTime;
}

interface CategoryTree {
  rows: Map<number, CategoryRow>;
  /** figli diretti in ordine di nome */
  children: Map<number, number[]>;
  /** FAQ direttamente nella categoria */
  faqCount: Map<number, number>;
}

async function loadCategoryTree(executor: DbOrTx): Promise<CategoryTree> {
  const [cats, counts] = await Promise.all([
    executor.selectFrom("faq_category").selectAll().orderBy("name").orderBy("category_id").execute(),
    executor
      .selectFrom("faq")
      .select(["category_id", (eb) => eb.fn.countAll<number>().as("n")])
      .groupBy("category_id")
      .execute(),
  ]);
  const rows = new Map<number, CategoryRow>(cats.map((c) => [c.category_id, c]));
  const children = new Map<number, number[]>();
  for (const c of cats) {
    if (c.category_pid === null || !rows.has(c.category_pid)) continue;
    children.set(c.category_pid, [...(children.get(c.category_pid) ?? []), c.category_id]);
  }
  return { rows, children, faqCount: new Map(counts.map((r) => [r.category_id, Number(r.n)])) };
}

/** Category::getNumFAQs(): FAQ della categoria + quelle dei figli diretti. */
function numFaqs(tree: CategoryTree, id: number): number {
  let n = tree.faqCount.get(id) ?? 0;
  for (const c of tree.children.get(id) ?? []) n += tree.faqCount.get(c) ?? 0;
  return n;
}

/** Catena dalla radice alla categoria (breadcrumb); si ferma sui cicli. */
function ancestry(tree: CategoryTree, id: number): { id: number; name: string }[] {
  const chain: { id: number; name: string }[] = [];
  const seen = new Set<number>();
  let cur = tree.rows.get(id);
  while (cur && !seen.has(cur.category_id)) {
    seen.add(cur.category_id);
    chain.unshift({ id: cur.category_id, name: cur.name ?? "" });
    cur = cur.category_pid ? tree.rows.get(cur.category_pid) : undefined;
  }
  return chain;
}

/** Category::getFullName(): "Padre / Figlio". */
const fullName = (tree: CategoryTree, id: number) =>
  ancestry(tree, id)
    .map((c) => c.name)
    .join(" / ");

interface KbCategorySummary {
  id: number;
  name: string;
  visibility: KbVisibility;
  faqCount: number;
}

function summary(tree: CategoryTree, id: number): KbCategorySummary {
  const r = tree.rows.get(id)!;
  return { id, name: r.name ?? "", visibility: visibilityOf(r.ispublic), faqCount: numFaqs(tree, id) };
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

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

// ---------------------------------------------------------------------------------------------
// Ricerca e filtri

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

interface KbFaqListItem {
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
      (SELECT COUNT(*) FROM ${table("attachment")} a WHERE a.type = 'F' AND a.object_id = f.faq_id AND a.inline = 0) AS attachments
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

// ---------------------------------------------------------------------------------------------
// Categoria

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

// ---------------------------------------------------------------------------------------------
// FAQ

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
    objectAttachments("F", faqId, executor),
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

// ---------------------------------------------------------------------------------------------
// Risposte predefinite

/**
 * Risposta visibile all'agente: globale (dept 0) o di un reparto accessibile; quelle disattivate solo
 * a chi gestisce le risposte (canned.manage), come l'elenco.
 */
export function cannedAccessible(agent: Agent, canned: { dept_id: number; isenabled: number }): boolean {
  if (canned.dept_id && !agent.deptIds.includes(canned.dept_id)) return false;
  return !!canned.isenabled || agent.hasPermInAnyRole(GlobalPerm.CANNED_MANAGE);
}

export const CANNED_SORTS = ["title", "dept", "status", "updated"] as const;
export type CannedSort = (typeof CANNED_SORTS)[number];

const CANNED_SORT_COLUMNS = {
  title: "c.title",
  dept: "d.name",
  status: "c.isenabled",
  updated: "c.updated",
} as const satisfies Record<CannedSort, string>;

/** getCannedResponses: risposte dei reparti dell'agente e globali (dept 0); se `all` anche disattivate. */
export async function listCanned(
  agent: Agent,
  opts: { all?: boolean; sort?: CannedSort; order?: "asc" | "desc" } = {},
  executor: DbOrTx = db(),
) {
  let q = executor
    .selectFrom("canned_response as c")
    .leftJoin("department as d", "d.id", "c.dept_id")
    .select(["c.canned_id", "c.title", "c.isenabled", "c.dept_id", "d.name as dept", "c.lang", "c.updated"])
    .select((eb) =>
      eb
        .selectFrom("attachment as a")
        .select(eb.fn.countAll<number>().as("n"))
        .where("a.type", "=", AttachmentType.CANNED)
        .whereRef("a.object_id", "=", "c.canned_id")
        .where("a.inline", "=", 0)
        .as("files"),
    )
    .where((eb) => eb.or([eb("c.dept_id", "=", 0), eb("c.dept_id", "in", agent.deptIds.length ? [...agent.deptIds] : [0])]));
  if (!opts.all) q = q.where("c.isenabled", "=", 1);
  const order = opts.order === "desc" ? "desc" : "asc";
  q = q.orderBy(CANNED_SORT_COLUMNS[opts.sort ?? "title"], order);
  if (opts.sort && opts.sort !== "title") q = q.orderBy("c.title");
  const rows = await q.orderBy("c.canned_id").execute();
  return rows.map((r) => ({ ...r, files: Number(r.files ?? 0) }));
}

interface CannedDetail {
  id: number;
  title: string;
  isEnabled: boolean;
  deptId: number;
  dept: string | null;
  lang: string;
  responseHtml: string;
  /** Canned::getPlainText(): Format::html2text (larghezza 90) */
  responseText: string;
  notesHtml: string;
  created: DbDateTime;
  updated: DbDateTime;
  attachments: KbAttachment[];
}

/** Dettaglio di una risposta predefinita (cannedresponse.inc.php in sola lettura); null se non accessibile. */
export async function getCanned(agent: Agent, cannedId: number, executor: DbOrTx = db()): Promise<CannedDetail | null> {
  if (!Number.isInteger(cannedId) || cannedId <= 0) return null;
  const row = await executor
    .selectFrom("canned_response as c")
    .leftJoin("department as d", "d.id", "c.dept_id")
    .select(["c.canned_id", "c.title", "c.response", "c.notes", "c.isenabled", "c.dept_id", "d.name as dept", "c.lang", "c.created", "c.updated"])
    .where("c.canned_id", "=", cannedId)
    .executeTakeFirst();
  if (!row || !cannedAccessible(agent, row)) return null;
  const attachments = await objectAttachments("C", cannedId, executor);
  return {
    id: row.canned_id,
    title: row.title,
    isEnabled: !!row.isenabled,
    deptId: row.dept_id,
    dept: row.dept,
    lang: row.lang,
    responseHtml: kbDisplayHtml(row.response),
    responseText: htmlToPlain(row.response),
    notesHtml: kbDisplayHtml(row.notes),
    created: row.created,
    updated: row.updated,
    attachments: attachments.filter((a) => !a.inline),
  };
}
