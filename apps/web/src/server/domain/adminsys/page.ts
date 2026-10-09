import "server-only";

import { sql } from "kysely";

import { table, type DbOrTx } from "../../db";
import { stripTags } from "../../format/html";
import { localizeInlineImages } from "../../format/text";
import type { MassResult, SaveResult } from "../admin/common";
import { OrmRow, SQL_NOW } from "../admin/orm";
import { inArray, phpLooseEquals, str, truthy, type PhpVars } from "../admin/php";
import type { Errors } from "../admin/validator";
import { sanitizeHtml } from "./sanitize";

/**
 * Pagine di contenuto: scp/pages.php → Page::update / disable / delete (include/class.page.php,
 * tabella `content`, allegati inline di tipo P).
 *
 * Stranezze replicate: dopo la creazione Draft::deleteForNamespace('page') cancella gli allegati di
 * tutte le bozze "page*" ma solo le bozze con namespace esattamente "page"; keepOnlyFileIds riceve
 * gli id file come chiavi (corretto) e l'indice come nome, quindi dalla seconda immagine nuova in poi
 * l'allegato prende come nome l'indice. Le traduzioni delle pagine (trans[…]) restano al pannello PHP.
 */
export const PAGE_TYPES = ["landing", "offline", "thank-you", "other"] as const;
export const LIST_TYPES = ["other", "landing", "thank-you", "offline"];

async function defaultPages(executor: DbOrTx): Promise<string[]> {
  const rows = await executor
    .selectFrom("config")
    .select(["key", "value"])
    .where("namespace", "=", "core")
    .where("key", "in", ["landing_page_id", "offline_page_id", "thank-you_page_id"])
    .execute();
  const get = (k: string) => rows.find((r) => r.key === k)?.value ?? "";
  return [get("landing_page_id"), get("offline_page_id"), get("thank-you_page_id")];
}

/** Page::isInUse: usata da un help topic o tra le pagine predefinite. */
async function isInUse(executor: DbOrTx, id: number): Promise<boolean> {
  const t = await executor.selectFrom("help_topic").select("topic_id").where("page_id", "=", id).executeTakeFirst();
  return !!t || inArray(id, await defaultPages(executor));
}

/** Draft::deleteForNamespace($namespace) */
export async function deleteDraftsForNamespace(executor: DbOrTx, namespace: string, staffId?: number): Promise<void> {
  const prefix = `${namespace.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  await sql`DELETE a.* FROM ${table("attachment")} a JOIN ${table("draft")} d ON (a.object_id=d.id AND a.type='D')
    WHERE d.namespace LIKE ${prefix}${staffId ? sql` AND d.staff_id=${staffId}` : sql``}`.execute(executor);
  let q = executor.deleteFrom("draft").where("namespace", "like", namespace);
  if (staffId) q = q.where("staff_id", "=", staffId);
  await q.execute();
}

/** Page::update($vars, $errors) per una pagina nuova (pageId null) o esistente. */
export async function savePage(executor: DbOrTx, pageId: number | null, vars: PhpVars): Promise<SaveResult> {
  let page: OrmRow;
  if (pageId) {
    const row = await OrmRow.load(executor, "content", "id", { id: pageId }, { touchUpdated: true });
    if (!row) return { ok: false, errors: { err: "unknown" } };
    page = row;
  } else {
    page = OrmRow.create("content", "id", { touchUpdated: true });
    page.set("created", SQL_NOW);
  }
  const errors: Errors = {};
  const name = stripTags(str(vars.name).trim());
  const isNew = page.isNew;
  if (!isNew && !truthy(vars.isactive) && (await isInUse(executor, page.num("id")))) {
    errors.err = "in_use";
    errors.isactive = "in_use";
  }
  if (!isNew && !phpLooseEquals(page.num("id"), vars.id ?? null)) errors.err = "internal";
  if (!truthy(vars.type)) errors.type = "type_required";
  if (!truthy(name)) errors.name = "name_required";
  else {
    const other = await executor.selectFrom("content").select("id").where("name", "=", name).orderBy("name").executeTakeFirst();
    if (other && !phpLooseEquals(other.id, isNew ? null : page.num("id"))) errors.name = "name_exists";
  }
  if (!truthy(vars.body)) errors.body = "body_required";
  if (Object.keys(errors).length) return { ok: false, errors };

  page.set("type", str(vars.type));
  page.set("name", name);
  page.set("body", sanitizeHtml(str(vars.body)));
  page.set("isactive", truthy(vars.isactive) ? 1 : 0);
  page.set("notes", sanitizeHtml(str(vars.notes)));
  await page.save(executor);
  const id = page.num("id");

  // Allegati inline dell'editor: keepOnlyFileIds(array_flip(id file), true)
  const keys = [...localizeInlineImages(str(vars.body)).matchAll(/"cid:([\w.-]{32})"/g)].map((m) => m[1]);
  const files = keys.length ? await executor.selectFrom("file").select(["id", "name"]).where("key", "in", keys).orderBy("id").execute() : [];
  const keep = new Map<number, number>(files.map((f, i) => [f.id, i]));
  const current = await executor.selectFrom("attachment").select(["id", "file_id", "inline", "lang"]).where("object_id", "=", id).where("type", "=", "P").orderBy("id").execute();
  for (const a of current) {
    if (!keep.has(a.file_id) && !a.lang && a.inline) await executor.deleteFrom("attachment").where("id", "=", a.id).execute();
    keep.delete(a.file_id);
  }
  for (const [fileId, index] of keep) {
    const file = files.find((f) => f.id === fileId);
    const name = index && file && file.name.toLowerCase() !== String(index) ? String(index) : null;
    await executor
      .insertInto("attachment")
      .values({ object_id: id, type: "P", file_id: fileId, inline: 1, ...(name !== null ? { name } : {}) } as never)
      .execute();
  }

  if (isNew) await deleteDraftsForNamespace(executor, "page");
  else await deleteDraftsForNamespace(executor, `page.${id}%`);
  return { ok: true, id, errors: {} };
}

export type PageMassAction = "enable" | "disable" | "delete";

/** scp/pages.php do=mass_process */
export async function massPages(executor: DbOrTx, action: PageMassAction, ids: number[]): Promise<MassResult> {
  if (!ids.length) return { ok: false, num: 0, error: "select_one" };
  const defaults = await defaultPages(executor);
  if (action !== "enable" && ids.some((i) => inArray(i, defaults))) return { ok: false, num: 0, error: "page_in_use" };
  if (action === "enable") {
    const n = await executor.selectFrom("content").select((eb) => eb.fn.countAll<number>().as("n")).where("id", "in", ids).where("isactive", "<>", 1).executeTakeFirstOrThrow();
    await executor.updateTable("content").set({ isactive: 1 }).where("id", "in", ids).execute();
    const num = Number(n.n);
    return num ? { ok: true, num } : { ok: false, num: 0, error: "failed" };
  }
  let i = 0;
  const pages = await executor.selectFrom("content").selectAll().where("id", "in", ids).orderBy("name").execute();
  for (const p of pages) {
    if (action === "disable") {
      if (!p.isactive) {
        i++;
        continue;
      }
      if (await isInUse(executor, p.id)) continue;
      const row = OrmRow.from("content", "id", p as unknown as Record<string, unknown>, { touchUpdated: true });
      row.set("isactive", 0);
      await row.save(executor);
      i++;
    } else {
      if (await isInUse(executor, p.id)) continue;
      await executor.deleteFrom("content").where("id", "=", p.id).execute();
      i++;
    }
  }
  return i ? { ok: true, num: i } : { ok: false, num: 0, error: "failed" };
}

export async function listPages(executor: DbOrTx) {
  const rows = await executor
    .selectFrom("content as c")
    .select((eb) => [
      "c.id",
      "c.name",
      "c.type",
      "c.isactive",
      "c.created",
      "c.updated",
      eb.selectFrom("help_topic as t").select((e) => e.fn.countAll<number>().as("n")).whereRef("t.page_id", "=", "c.id").as("topics"),
    ])
    .where("c.type", "in", LIST_TYPES)
    .orderBy("c.name")
    .execute();
  const defaults = await defaultPages(executor);
  return rows.map((r) => ({ ...r, topics: Number(r.topics), isDefault: inArray(r.id, defaults) }));
}

