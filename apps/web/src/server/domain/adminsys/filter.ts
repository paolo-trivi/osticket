import "server-only";

import type { DbOrTx } from "../../db";
import { isNumeric, phpLooseEquals, str, truthy, type PhpVal, type PhpVars } from "../../php/values";
import { sanitizeHtml as sanitizeText } from "./sanitize";
import type { MassResult, SaveResult } from "../admin/common";
import { OrmRow, SQL_NOW } from "../admin/orm";
import { ov, pv } from "./orm-util";
import type { Errors } from "../admin/validator";
import { saveActions, validateActions } from "./filter-actions";
import { dbRules, saveRules, validateRules, type FilterCtx } from "./filter-rules";

/**
 * Filtri dei ticket: scp/filters.php → Filter::update / Filter::delete (include/class.filter.php)
 * con le regole (`filter_rule`, sostituite a ogni salvataggio) e le azioni (`filter_action`,
 * configurazione JSON prodotta dai form delle TriggerAction di include/class.filter_action.php).
 *
 * Stranezze del PHP replicate (annotate anche nel codice):
 * - senza `actions[]` nel POST validate_actions restituisce null e il salvataggio fallisce senza errori;
 * - un'azione con valore vuoto blocca il salvataggio con `err` e interrompe la validazione;
 * - se l'ultima azione del POST è esistente (`I<id>`), validate_actions chiama tre volte
 *   Filter::setFlag sul filtro dell'azione: ognuna esegue Filter::update sui dati del modello e
 *   ricrea le regole (DELETE + INSERT con `created` vuoto, `isactive` e `notes` di default);
 * - errori di un'azione in save_actions: il filtro e le azioni precedenti sono già salvati, le
 *   successive vengono salvate con `configuration` NULL, le regole non vengono salvate;
 * - le regole nuove hanno `created` = '0000-00-00 00:00:00' (save_rules non lo imposta).
 * Regole in filter-rules.ts, azioni in filter-actions.ts.
 * La ban list di sistema ("SYSTEM BAN LIST") ha la sua pagina e qui non si modifica.
 */

export const TARGETS = ["Any", "Web", "API", "Email"] as const;

/** Filtri caricati in questa richiesta (cache dei modelli dell'ORM: stessa istanza). */
const rowCache = new WeakMap<DbOrTx, Map<number, OrmRow>>();

async function loadFilter(executor: DbOrTx, id: number): Promise<OrmRow | null> {
  let cache = rowCache.get(executor);
  if (!cache) rowCache.set(executor, (cache = new Map()));
  const hit = cache.get(id);
  if (hit) return hit;
  const row = await OrmRow.load(executor, "filter", "id", { id }, { touchUpdated: true });
  if (row) cache.set(id, row);
  return row;
}

/** Filter::setFlag($flag, $val) */
async function setFlag(ctx: FilterCtx, filterId: number, flag: number, on: boolean): Promise<void> {
  const f = await loadFilter(ctx.executor, filterId);
  if (!f) return;
  const flags = f.num("flags");
  f.set("flags", on ? flags | flag : flags & ~flag);
  const ht: PhpVars = {};
  for (const [k, v] of Object.entries(f.ht)) ht[k] = typeof v === "symbol" ? null : (v as PhpVal);
  ht.pass = true;
  ht.rules = (await dbRules(ctx.executor, filterId)) as unknown as PhpVal;
  await filterUpdate(ctx, f, ht, {});
}

/** Filter::update($vars, $errors) */
async function filterUpdate(ctx: FilterCtx, filter: OrmRow, vars: PhpVars, errors: Errors): Promise<boolean> {
  if (!(await validateActions(ctx, vars, errors, (id, flag, on) => setFlag(ctx, id, flag, on)))) return false;
  vars = { ...vars, flags: pv(filter.get("flags")) };
  if (!truthy(vars.execorder)) errors.execorder = "order_required";
  else if (!isNumeric(vars.execorder ?? null)) errors.execorder = "numeric";
  if (!truthy(vars.name)) errors.name = "name_required";
  else {
    const other = await ctx.executor.selectFrom("filter").select("id").where("name", "=", str(vars.name)).executeTakeFirst();
    if (other && !phpLooseEquals(other.id, filter.isNew ? null : filter.get("id"))) errors.name = "name_in_use";
  }
  if (!Object.keys(errors).length && !(await validateRules(ctx, vars.rules as PhpVal, errors)).length && !errors.rules) errors.rules = "invalid_rules";
  const target = vars.target;
  if (!truthy(target)) errors.target = "target_required";
  else if (!isNumeric(target ?? null) && !(TARGETS as readonly string[]).includes(str(target))) errors.target = "invalid_target";
  if (Object.keys(errors).length) return false;

  let emailId: PhpVal = 0;
  let tgt: PhpVal = target;
  if (isNumeric(target ?? null)) {
    emailId = target;
    tgt = "Email";
  }
  if (truthy(vars.email_id)) emailId = vars.email_id;
  filter.set("isactive", ov(vars.isactive ?? null));
  filter.set("flags", ov(vars.flags ?? null));
  filter.set("target", ov(tgt ?? null));
  filter.set("name", ov(vars.name ?? null));
  filter.set("execorder", ov(vars.execorder ?? null));
  filter.set("email_id", ov(emailId ?? null));
  filter.set("match_all_rules", ov(vars.match_all_rules ?? null));
  filter.set("stop_onmatch", ov(vars.stop_onmatch ?? null));
  filter.set("notes", sanitizeText(str(vars.notes ?? null)));
  await filter.save(ctx.executor);
  if (filter.isNew) return false;
  const id = filter.num("id");
  rowCache.get(ctx.executor)?.set(id, filter);

  await saveActions(ctx, id, vars, errors);
  if (Object.keys(errors).length) return false;
  return saveRules(ctx, id, vars.rules as PhpVal);
}

/** scp/filters.php do=add / do=update */
export async function saveFilter(executor: DbOrTx, filterId: number | null, vars: PhpVars): Promise<SaveResult> {
  const ctx: FilterCtx = { executor };
  rowCache.delete(executor);
  let filter: OrmRow;
  if (filterId) {
    const row = await loadFilter(executor, filterId);
    if (!row) return { ok: false, errors: { err: "unknown" } };
    if (str(pv(row.get("name"))).toLowerCase() === "system ban list") return { ok: false, errors: { err: "banlist" } };
    filter = row;
  } else {
    filter = OrmRow.create("filter", "id", { touchUpdated: true });
    filter.set("created", SQL_NOW);
  }
  const errors: Errors = {};
  const ok = await filterUpdate(ctx, filter, vars, errors);
  rowCache.delete(executor);
  return { ok, id: ok ? filter.num("id") : null, errors };
}

export type FilterMassAction = "enable" | "disable" | "delete";

/** scp/filters.php do=mass_process */
export async function massFilters(executor: DbOrTx, action: FilterMassAction, ids: number[]): Promise<MassResult> {
  if (!ids.length) return { ok: false, num: 0, error: "select_one" };
  let num = 0;
  if (action === "enable" || action === "disable") {
    const rows = await executor.selectFrom("filter").selectAll().where("id", "in", ids).orderBy("execorder").execute();
    for (const r of rows) {
      const f = OrmRow.from("filter", "id", r as unknown as Record<string, unknown>, { touchUpdated: true });
      f.set("isactive", action === "enable" ? 1 : 0);
      await f.save(executor);
      num++;
    }
  } else {
    for (const id of ids) {
      const f = await executor.selectFrom("filter").select(["id", "name"]).where("id", "=", id).executeTakeFirst();
      if (!f || f.name.toLowerCase() === "system ban list") continue;
      // Filter::delete: riga, regole e azioni (Signal object.deleted: nessun effetto per i filtri)
      await executor.deleteFrom("filter").where("id", "=", id).execute();
      await executor.deleteFrom("filter_rule").where("filter_id", "=", id).execute();
      await executor.deleteFrom("filter_action").where("filter_id", "=", id).execute();
      num++;
    }
  }
  return num ? { ok: true, num } : { ok: false, num: 0, error: "failed" };
}

/** Dati del filtro per il form (include/staff/filter.inc.php). */
export async function filterInfo(executor: DbOrTx, id: number) {
  const filter = await executor.selectFrom("filter").selectAll().where("id", "=", id).executeTakeFirst();
  if (!filter) return null;
  const rules = await executor.selectFrom("filter_rule").selectAll().where("filter_id", "=", id).orderBy("id").execute();
  const actions = await executor.selectFrom("filter_action").selectAll().where("filter_id", "=", id).orderBy("sort").execute();
  return { filter, rules, actions };
}

export async function listFilters(executor: DbOrTx) {
  const rows = await executor
    .selectFrom("filter as f")
    .select((eb) => [
      "f.id",
      "f.name",
      "f.execorder",
      "f.isactive",
      "f.flags",
      "f.target",
      "f.email_id",
      "f.created",
      "f.updated",
      eb.selectFrom("filter_rule as r").select((e) => e.fn.countAll<number>().as("n")).whereRef("r.filter_id", "=", "f.id").as("rules"),
    ])
    .orderBy("f.execorder")
    .orderBy("f.name")
    .execute();
  return rows;
}
