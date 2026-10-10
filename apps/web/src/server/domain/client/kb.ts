import "server-only";

import { sql, type SqlBool } from "kysely";

import { AttachmentType } from "@/lib/osticket/object-types";

import type { ConfigNamespace } from "../../config/config";
import { db, table, type DbOrTx } from "../../db";
import { likeEscape } from "../../db/like";
import { stripTags } from "../../format/html";
import type { ClientIdentity } from "./identity";

/**
 * Knowledge base pubblica del portale (kb/index.php, kb/faq.php, include/client/kb-*.inc.php,
 * faq*.inc.php) e pagine di contenuto (landing, thank-you). Sola lettura: il PHP non registra le
 * visualizzazioni delle FAQ (non esiste una colonna faq.views).
 * Visibilità: FAQ con ispublished != 0 (1 pubblica, 2 in evidenza) in categorie con ispublic != 0.
 */

/** OsticketConfig::isKnowledgebaseEnabled + kb.inc.php (almeno una FAQ pubblicata) */
export async function kbEnabled(cfg: ConfigNamespace, client: ClientIdentity | null, executor: DbOrTx = db()): Promise<boolean> {
  if (cfg.bool("restrict_kb") && (!client || client.guest)) return false;
  if (!cfg.bool("enable_kb")) return false;
  return (await countPublishedFaqs(executor)) > 0;
}

/** FAQ::countPublishedFAQs */
async function countPublishedFaqs(executor: DbOrTx = db()): Promise<number> {
  const { rows } = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM ${table("faq")} F JOIN ${table("faq_category")} C ON (C.category_id = F.category_id)
    WHERE F.ispublished != 0 AND C.ispublic != 0`.execute(executor);
  return Number(rows[0]?.n ?? 0);
}

interface KbFaqLink {
  id: number;
  question: string;
  teaser?: string;
  attachments?: number;
}

interface KbCategory {
  id: number;
  name: string;
  description: string;
  count: number;
  subcategories: { id: number; name: string; count: number }[];
  faqs: KbFaqLink[];
}

/** FAQ::getTeaser: testo della risposta senza tag, troncato a 150 caratteri */
function teaser(answer: string): string {
  const text = stripTags(answer).replace(/\s+/g, " ").trim();
  if (text.length <= 150) return text;
  const cut = text.slice(0, 150);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 0)) || cut}...`;
}

/**
 * Categorie della pagina principale (kb-categories.inc.php): categorie pubbliche con FAQ pubblicate
 * (proprie o delle sottocategorie), senza le sottocategorie il cui padre è già elencato; per ognuna
 * le sottocategorie pubbliche e fino a 5 FAQ.
 */
export async function publicCategories(executor: DbOrTx = db()): Promise<KbCategory[]> {
  const { rows } = await sql<{ category_id: number; category_pid: number | null; name: string; description: string | null; faqs: number; child_faqs: number }>`
    SELECT C.category_id, C.category_pid, C.name, C.description,
      (SELECT COUNT(*) FROM ${table("faq")} F WHERE F.category_id = C.category_id AND F.ispublished > 0) AS faqs,
      (SELECT COUNT(*) FROM ${table("faq_category")} CC JOIN ${table("faq")} F2 ON (F2.category_id = CC.category_id)
        WHERE CC.category_pid = C.category_id AND CC.ispublic != 0 AND F2.ispublished > 0) AS child_faqs
    FROM ${table("faq_category")} C
    WHERE C.ispublic != 0
    ORDER BY C.name`.execute(executor);
  const visible = rows.filter((r) => Number(r.faqs) + Number(r.child_faqs) > 0);
  const ids = new Set(visible.map((r) => r.category_id));
  const out: KbCategory[] = [];
  for (const c of visible) {
    if (c.category_pid && ids.has(c.category_pid)) continue;
    const subs = rows.filter((s) => s.category_pid === c.category_id && Number(s.faqs) > 0).map((s) => ({ id: s.category_id, name: s.name, count: Number(s.faqs) }));
    const faqs = await executor
      .selectFrom("faq")
      .select(["faq_id", "question"])
      .where("category_id", "=", c.category_id)
      .where("ispublished", "!=", 0)
      .orderBy("faq_id")
      .limit(5)
      .execute();
    out.push({
      id: c.category_id,
      name: c.name,
      description: c.description ?? "",
      count: Number(c.faqs) + Number(c.child_faqs),
      subcategories: subs,
      faqs: faqs.map((f) => ({ id: f.faq_id, question: f.question })),
    });
  }
  return out;
}

/** Categorie in evidenza (Category::getFeatured, ispublic = 2) con i primi articoli (getTopArticles) */
export async function featuredCategories(executor: DbOrTx = db()): Promise<KbCategory[]> {
  const cats = await executor.selectFrom("faq_category").select(["category_id", "name", "description"]).where("ispublic", "=", 2).orderBy("name").execute();
  const out: KbCategory[] = [];
  for (const c of cats) {
    const faqs = await executor
      .selectFrom("faq")
      .select(["faq_id", "question", "answer"])
      .where("category_id", "=", c.category_id)
      .where("ispublished", "!=", 0)
      .orderBy("ispublished", "desc")
      .limit(5)
      .execute();
    out.push({
      id: c.category_id,
      name: c.name ?? "",
      description: c.description ?? "",
      count: faqs.length,
      subcategories: [],
      faqs: faqs.map((f) => ({ id: f.faq_id, question: f.question, teaser: teaser(f.answer) })),
    });
  }
  return out;
}

/** Help topic con FAQ collegate (filtro "per argomento") */
export async function topicsWithFaqs(executor: DbOrTx = db(), categoryId?: number): Promise<{ id: number; name: string }[]> {
  const { rows } = await sql<{ topic_id: number; topic: string }>`
    SELECT DISTINCT T.topic_id, T.topic FROM ${table("help_topic")} T
    JOIN ${table("faq_topic")} FT ON (FT.topic_id = T.topic_id)
    JOIN ${table("faq")} F ON (F.faq_id = FT.faq_id)
    WHERE ${categoryId ? sql<SqlBool>`F.category_id = ${categoryId}` : sql<SqlBool>`1 = 1`}
    ORDER BY T.topic`.execute(executor);
  return rows.map((r) => ({ id: r.topic_id, name: r.topic }));
}

/**
 * Ricerca (knowledgebase.inc.php con q/cid/topicId): FAQ pubbliche in categorie pubbliche, testo
 * cercato in domanda, risposta, parole chiave, nome e descrizione della categoria; ordine per domanda.
 */
export async function searchFaqs(opts: { q?: string; categoryId?: number; topicId?: number }, executor: DbOrTx = db()): Promise<KbFaqLink[]> {
  const where: ReturnType<typeof sql<SqlBool>>[] = [sql<SqlBool>`F.ispublished != 0`, sql<SqlBool>`C.ispublic != 0`];
  if (opts.categoryId) where.push(sql<SqlBool>`F.category_id = ${opts.categoryId}`);
  if (opts.topicId) where.push(sql<SqlBool>`F.faq_id IN (SELECT faq_id FROM ${table("faq_topic")} WHERE topic_id = ${opts.topicId})`);
  const q = (opts.q ?? "").trim();
  if (q) {
    const like = `%${likeEscape(q)}%`;
    where.push(sql<SqlBool>`(F.question LIKE ${like} OR F.answer LIKE ${like} OR F.keywords LIKE ${like} OR C.name LIKE ${like} OR C.description LIKE ${like})`);
  }
  const { rows } = await sql<{ faq_id: number; question: string; atts: number }>`
    SELECT F.faq_id, F.question,
      (SELECT COUNT(*) FROM ${table("attachment")} A WHERE A.type = 'F' AND A.object_id = F.faq_id AND A.inline = 0) AS atts
    FROM ${table("faq")} F JOIN ${table("faq_category")} C ON (C.category_id = F.category_id)
    WHERE ${sql.join(where, sql` AND `)}
    ORDER BY F.question`.execute(executor);
  return rows.map((r) => ({ id: r.faq_id, question: r.question, attachments: Number(r.atts) }));
}

interface KbCategoryView {
  id: number;
  name: string;
  description: string;
  parent: { id: number; name: string } | null;
  subcategories: { id: number; name: string; count: number }[];
  faqs: KbFaqLink[];
  topics: { id: number; name: string }[];
}

/** Categoria pubblica (faq-category.inc.php): sottocategorie pubbliche con FAQ, FAQ in evidenza prima */
export async function publicCategory(id: number, executor: DbOrTx = db()): Promise<KbCategoryView | null> {
  const c = await executor.selectFrom("faq_category").select(["category_id", "category_pid", "name", "description", "ispublic"]).where("category_id", "=", id).executeTakeFirst();
  if (!c || !c.ispublic) return null;
  const parent = c.category_pid ? await executor.selectFrom("faq_category").select(["category_id", "name"]).where("category_id", "=", c.category_pid).executeTakeFirst() : undefined;
  const { rows: subs } = await sql<{ category_id: number; name: string; n: number }>`
    SELECT C.category_id, C.name, (SELECT COUNT(*) FROM ${table("faq")} F WHERE F.category_id = C.category_id AND F.ispublished > 0) AS n
    FROM ${table("faq_category")} C WHERE C.category_pid = ${id} AND C.ispublic != 0 ORDER BY C.name`.execute(executor);
  const { rows: faqs } = await sql<{ faq_id: number; question: string; atts: number }>`
    SELECT F.faq_id, F.question,
      (SELECT COUNT(*) FROM ${table("attachment")} A WHERE A.type = 'F' AND A.object_id = F.faq_id AND A.inline = 0) AS atts
    FROM ${table("faq")} F WHERE F.category_id = ${id} AND F.ispublished != 0
    ORDER BY F.ispublished DESC, F.question`.execute(executor);
  return {
    id: c.category_id,
    name: c.name ?? "",
    description: c.description ?? "",
    parent: parent ? { id: parent.category_id, name: parent.name ?? "" } : null,
    subcategories: subs.filter((s) => Number(s.n) > 0).map((s) => ({ id: s.category_id, name: s.name, count: Number(s.n) })),
    faqs: faqs.map((f) => ({ id: f.faq_id, question: f.question, attachments: Number(f.atts) })),
    topics: await topicsWithFaqs(executor, id),
  };
}

interface KbFaqView {
  id: number;
  question: string;
  answer: string;
  updated: string;
  category: { id: number; name: string };
  attachments: { id: number; key: string; name: string; size: number }[];
  topics: string[];
}

/** FAQ pubblicata (faq.inc.php): pubblica e in categoria pubblica (FAQ::isPublished) */
export async function publicFaq(id: number, executor: DbOrTx = db()): Promise<KbFaqView | null> {
  const f = await executor
    .selectFrom("faq as f")
    .innerJoin("faq_category as c", "c.category_id", "f.category_id")
    .select(["f.faq_id", "f.question", "f.answer", "f.updated", "f.ispublished", "c.category_id", "c.name", "c.ispublic"])
    .where("f.faq_id", "=", id)
    .executeTakeFirst();
  if (!f || !f.ispublished || !f.ispublic) return null;
  const atts = await executor
    .selectFrom("attachment as a")
    .innerJoin("file as fl", "fl.id", "a.file_id")
    .select(["a.id", "fl.key", "a.name", "fl.name as fname", "fl.size"])
    .where("a.type", "=", AttachmentType.FAQ)
    .where("a.object_id", "=", id)
    .where("a.inline", "=", 0)
    .orderBy("a.id")
    .execute();
  const topics = await executor
    .selectFrom("faq_topic as ft")
    .innerJoin("help_topic as t", "t.topic_id", "ft.topic_id")
    .select("t.topic")
    .where("ft.faq_id", "=", id)
    .execute();
  return {
    id: f.faq_id,
    question: f.question,
    answer: f.answer,
    updated: f.updated,
    category: { id: f.category_id, name: f.name ?? "" },
    attachments: atts.map((a) => ({ id: a.id, key: a.key, name: a.name || a.fname, size: Number(a.size) })),
    topics: topics.map((t) => t.topic),
  };
}

/** Allegato di una FAQ pubblicata (anche immagini inline della risposta) per chiave del file */
export async function publicFaqFile(key: string, executor: DbOrTx = db()): Promise<{ fileId: number; name: string | null } | null> {
  const r = await executor
    .selectFrom("file as fl")
    .innerJoin("attachment as a", "a.file_id", "fl.id")
    .innerJoin("faq as f", (j) => j.onRef("f.faq_id", "=", "a.object_id").on("a.type", "=", AttachmentType.FAQ))
    .innerJoin("faq_category as c", "c.category_id", "f.category_id")
    .select(["fl.id", "a.name"])
    .where("fl.key", "=", key)
    .where("f.ispublished", "!=", 0)
    .where("c.ispublic", "!=", 0)
    .executeTakeFirst();
  return r ? { fileId: r.id, name: r.name } : null;
}

/** Pagina di contenuto attiva per id (Page::lookup: landing, offline, thank-you) */
export async function contentPage(id: number, executor: DbOrTx = db()): Promise<{ name: string; body: string } | null> {
  if (!id) return null;
  const p = await executor.selectFrom("content").select(["name", "body", "isactive"]).where("id", "=", id).executeTakeFirst();
  return p ? { name: p.name, body: p.body } : null;
}

/** Pagina di contenuto per tipo (Page::lookupByType: banner-client, registration-confirm, …) */
export async function contentPageByType(type: string, executor: DbOrTx = db()): Promise<{ name: string; body: string } | null> {
  const p = await executor.selectFrom("content").select(["name", "body"]).where("type", "=", type).orderBy("id").executeTakeFirst();
  return p ?? null;
}
