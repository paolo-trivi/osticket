import "server-only";

import { sql } from "kysely";

import { db, table, type DbOrTx } from "../../db";
import type { Agent } from "../staff/staff";

/** Knowledge base (FAQ, categorie) e risposte predefinite (canned) — doc 07 §2–3. */

export async function listCategories(executor: DbOrTx = db()) {
  const { rows } = await sql<{
    category_id: number;
    category_pid: number | null;
    name: string;
    ispublic: number;
    description: string;
    faqs: number;
    published: number;
  }>`SELECT C.category_id, C.category_pid, C.name, C.ispublic, C.description,
      (SELECT COUNT(*) FROM ${table("faq")} F WHERE F.category_id = C.category_id) AS faqs,
      (SELECT COUNT(*) FROM ${table("faq")} F WHERE F.category_id = C.category_id AND F.ispublished > 0) AS published
    FROM ${table("faq_category")} C ORDER BY C.name`.execute(executor);
  return rows.map((r) => ({ ...r, faqs: Number(r.faqs), published: Number(r.published) }));
}

export async function listFaqs(opts: { categoryId?: number; q?: string }, executor: DbOrTx = db()) {
  let q = executor
    .selectFrom("faq as f")
    .innerJoin("faq_category as c", "c.category_id", "f.category_id")
    .select(["f.faq_id", "f.question", "f.ispublished", "f.updated", "f.category_id", "c.name as category", "c.ispublic"]);
  if (opts.categoryId) q = q.where("f.category_id", "=", opts.categoryId);
  if (opts.q) {
    const like = `%${opts.q}%`;
    q = q.where((eb) => eb.or([eb("f.question", "like", like), eb("f.answer", "like", like), eb("f.keywords", "like", like)]));
  }
  return q.orderBy("f.question").execute();
}

export async function loadFaq(id: number, executor: DbOrTx = db()) {
  const faq = await executor
    .selectFrom("faq as f")
    .innerJoin("faq_category as c", "c.category_id", "f.category_id")
    .select(["f.faq_id", "f.question", "f.answer", "f.keywords", "f.notes", "f.ispublished", "f.created", "f.updated", "f.category_id", "c.name as category", "c.ispublic"])
    .where("f.faq_id", "=", id)
    .executeTakeFirst();
  if (!faq) return null;
  const [topics, attachments] = await Promise.all([
    executor
      .selectFrom("faq_topic as ft")
      .innerJoin("help_topic as t", "t.topic_id", "ft.topic_id")
      .select(["t.topic_id", "t.topic"])
      .where("ft.faq_id", "=", id)
      .execute(),
    executor
      .selectFrom("attachment as a")
      .innerJoin("file as fl", "fl.id", "a.file_id")
      .select(["a.id", "fl.name", "fl.size", "fl.key"])
      .where("a.type", "=", "F")
      .where("a.object_id", "=", id)
      .execute(),
  ]);
  return { ...faq, topics, attachments };
}

/** getCannedResponses: risposte dei reparti dell'agente e globali (dept 0); se `all` anche disattivate. */
export async function listCanned(agent: Agent, opts: { all?: boolean } = {}, executor: DbOrTx = db()) {
  let q = executor
    .selectFrom("canned_response as c")
    .leftJoin("department as d", "d.id", "c.dept_id")
    .select(["c.canned_id", "c.title", "c.isenabled", "c.dept_id", "d.name as dept", "c.lang", "c.updated"])
    .where((eb) => eb.or([eb("c.dept_id", "=", 0), eb("c.dept_id", "in", agent.deptIds.length ? [...agent.deptIds] : [0])]));
  if (!opts.all) q = q.where("c.isenabled", "=", 1);
  return q.orderBy("c.title").execute();
}

export async function loadCanned(id: number, executor: DbOrTx = db()) {
  return executor
    .selectFrom("canned_response as c")
    .leftJoin("department as d", "d.id", "c.dept_id")
    .select(["c.canned_id", "c.title", "c.response", "c.notes", "c.isenabled", "c.dept_id", "d.name as dept", "c.lang", "c.created", "c.updated"])
    .where("c.canned_id", "=", id)
    .executeTakeFirst();
}
