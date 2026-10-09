import "server-only";

import { sql } from "kysely";

import { table, type DbOrTx } from "../../db";
import { sanitizeHtml as sanitizeText } from "./sanitize";
import type { MassResult, SaveResult } from "../admin/common";
import { OrmRow, SQL_NOW } from "../admin/orm";
import { intval, isset, str, truthy, type PhpVars } from "../admin/php";
import { isEmail } from "../directory/forms";

/**
 * Ban list delle email (scp/banlist.php, include/class.banlist.php): le regole `email equal <addr>`
 * del filtro di sistema "SYSTEM BAN LIST" (azione reject).
 *
 * Differenza annotata: Banlist::getFilter() crea il filtro di sistema se manca (Filter::create);
 * il filtro esiste sempre dopo l'installazione, qui se manca si restituisce l'errore `no_banlist`
 * e la creazione resta al pannello PHP.
 */
export const BANLIST_NAME = "SYSTEM BAN LIST";

/** Filter::getByName('SYSTEM BAN LIST') */
export async function banlistFilterId(executor: DbOrTx): Promise<number | null> {
  const row = await executor.selectFrom("filter").select("id").where("name", "=", BANLIST_NAME).orderBy("execorder").executeTakeFirst();
  return row?.id ?? null;
}

export interface BanRule {
  id: number;
  val: string;
  isactive: number;
  notes: string;
  created: string;
  updated: string;
}

export async function listBanRules(executor: DbOrTx, q?: string): Promise<{ filterId: number | null; isactive: boolean; rules: BanRule[] }> {
  const filterId = await banlistFilterId(executor);
  if (!filterId) return { filterId, isactive: false, rules: [] };
  const f = await executor.selectFrom("filter").select("isactive").where("id", "=", filterId).executeTakeFirstOrThrow();
  let qb = executor
    .selectFrom("filter_rule")
    .select(["id", "val", "isactive", "notes", "created", "updated"])
    .where("filter_id", "=", filterId)
    .where("what", "=", "email");
  if (q) qb = qb.where("val", "like", `%${q}%`);
  const rules = await qb.orderBy("val").execute();
  return { filterId, isactive: !!f.isactive, rules: rules.map((r) => ({ ...r, created: String(r.created), updated: String(r.updated) })) };
}

/** Banlist::includes / Filter::containsRule('email', 'equal', $val) */
async function containsRule(executor: DbOrTx, filterId: number, val: string): Promise<boolean> {
  const row = await executor
    .selectFrom("filter_rule")
    .select("id")
    .where("filter_id", "=", filterId)
    .where("what", "=", "email")
    .where("how", "=", "equal")
    .where("val", "=", val)
    .executeTakeFirst();
  return !!row;
}

/** scp/banlist.php do=add → Filter::addRule('email', 'equal', trim($val), [isactive, notes]) */
export async function addBanRule(executor: DbOrTx, vars: PhpVars): Promise<SaveResult> {
  const filterId = await banlistFilterId(executor);
  if (!filterId) return { ok: false, errors: { err: "no_banlist" } };
  const val = str(vars.val);
  if (!truthy(vars.val) || !isEmail(val)) return { ok: false, errors: { err: "valid_email_required", val: "valid_email_required" } };
  if (await containsRule(executor, filterId, val.trim())) return { ok: false, errors: { err: "already_banned", val: "already_banned" } };
  // array_merge($extra, [what, how, val]) → new FilterRule($rule): l'ordine non conta, i campi
  // "uguali a NULL" non sono dirty (default della colonna)
  const rule = OrmRow.create("filter_rule", "id");
  rule.set("isactive", vars.isactive === undefined ? null : str(vars.isactive));
  if (isset(vars, "notes")) rule.set("notes", sanitizeText(str(vars.notes)));
  rule.set("what", "email");
  rule.set("how", "equal");
  rule.set("val", val.trim());
  rule.set("created", SQL_NOW);
  rule.set("filter_id", filterId);
  // FilterRule::save: updated = NOW() se dirty
  rule.set("updated", SQL_NOW);
  await rule.save(executor);
  return { ok: true, id: Number(rule.get("id")), errors: {} };
}

/** scp/banlist.php do=update → FilterRule::update */
export async function updateBanRule(executor: DbOrTx, ruleId: number, vars: PhpVars): Promise<SaveResult> {
  const filterId = await banlistFilterId(executor);
  if (!filterId) return { ok: false, errors: { err: "no_banlist" } };
  const rule = await OrmRow.load(executor, "filter_rule", "id", { id: ruleId, filter_id: filterId });
  if (!rule) return { ok: false, errors: { err: "unknown_rule" } };
  const val = str(vars.val);
  if (!truthy(vars.val) || !isEmail(val)) return { ok: false, errors: { err: "valid_email_required", val: "valid_email_required" } };
  rule.set("what", "email");
  rule.set("how", "equal");
  rule.set("val", val.trim());
  rule.set("isactive", isset(vars, "isactive") ? intval(vars.isactive) : 1);
  if (isset(vars, "notes")) rule.set("notes", sanitizeText(str(vars.notes)));
  if (rule.isDirty()) rule.set("updated", SQL_NOW);
  await rule.save(executor);
  return { ok: true, id: ruleId, errors: {} };
}

export type BanMassAction = "enable" | "disable" | "delete";

/** scp/banlist.php do=mass_process */
export async function massBanRules(executor: DbOrTx, action: BanMassAction, ids: number[]): Promise<MassResult> {
  const filterId = await banlistFilterId(executor);
  if (!filterId) return { ok: false, num: 0, error: "no_banlist" };
  if (!ids.length) return { ok: false, num: 0, error: "select_one" };
  if (action === "enable" || action === "disable") {
    const value = action === "enable" ? 1 : 0;
    // db_affected_rows() di mysqli conta le righe effettivamente cambiate (mysql2 conta quelle trovate)
    const changed = await executor
      .selectFrom("filter_rule")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("filter_id", "=", filterId)
      .where("id", "in", ids)
      .where("isactive", "<>", value)
      .executeTakeFirstOrThrow();
    // UPDATE diretto senza `updated` (come il PHP)
    await sql`UPDATE ${table("filter_rule")} SET isactive=${value} WHERE filter_id=${filterId} AND id IN (${sql.join(ids)})`.execute(executor);
    const num = Number(changed.n);
    return num ? { ok: true, num } : { ok: false, num: 0, error: "failed" };
  }
  let i = 0;
  for (const id of ids) {
    const r = await executor.selectFrom("filter_rule").select(["id", "filter_id"]).where("id", "=", id).executeTakeFirst();
    if (r && r.filter_id === filterId) {
      await executor.deleteFrom("filter_rule").where("id", "=", id).execute();
      i++;
    }
  }
  return i ? { ok: true, num: i } : { ok: false, num: 0, error: "failed" };
}

