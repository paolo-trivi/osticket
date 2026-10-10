import "server-only";

import type { DbOrTx } from "../../db";
import type { DbDateTime } from "../../db/schema.gen";
import { visibilityOf, type KbVisibility } from "./common";

/** Albero delle categorie della KB (faq_category) con il numero di FAQ per categoria. */

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

export async function loadCategoryTree(executor: DbOrTx): Promise<CategoryTree> {
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
export function ancestry(tree: CategoryTree, id: number): { id: number; name: string }[] {
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
export const fullName = (tree: CategoryTree, id: number) =>
  ancestry(tree, id)
    .map((c) => c.name)
    .join(" / ");

export interface KbCategorySummary {
  id: number;
  name: string;
  visibility: KbVisibility;
  faqCount: number;
}

export function summary(tree: CategoryTree, id: number): KbCategorySummary {
  const r = tree.rows.get(id)!;
  return { id, name: r.name ?? "", visibility: visibilityOf(r.ispublic), faqCount: numFaqs(tree, id) };
}

export const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
