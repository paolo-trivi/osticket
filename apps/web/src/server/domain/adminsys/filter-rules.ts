import "server-only";

import { FormType } from "@/lib/osticket/object-types";

import type { DbOrTx } from "../../db";
import { str, truthy, type PhpVal } from "../../php/values";
import { OrmRow } from "../admin/orm";
import type { Errors } from "../admin/validator";
import { isEmail } from "../forms/validator";
import { prepareSupportedMatches } from "../filter/ticket-filter";

/**
 * Regole dei filtri dei ticket (include/class.filter.php): campi confrontabili, validazione
 * (Filter::validate_rules) e sostituzione completa delle righe `filter_rule` (Filter::save_rules).
 */

export const MATCH_TYPES = ["equal", "not_equal", "contains", "dn_contain", "starts", "ends", "match", "not_match"] as const;

/** Stato di un salvataggio in corso: errori condivisi come l'array $errors passato per riferimento. */
export interface FilterCtx {
  executor: DbOrTx;
  matchFields?: Set<string>;
}

/** Filter::getSupportedMatchFields (con gli effetti collaterali sui form delle liste). */
async function supportedMatchFields(ctx: FilterCtx): Promise<Set<string>> {
  if (ctx.matchFields) return ctx.matchFields;
  await prepareSupportedMatches(ctx.executor);
  const out = new Set(["name", "email", "reply-to", "reply-to-name", "addressee", "topicId"]);
  for (const f of await matchFieldList(ctx.executor)) out.add(f.key);
  ctx.matchFields = out;
  return out;
}

/** Campi dei form U, T, G e O usabili nelle regole (field.<id> e sotto-campi delle liste). */
export async function matchFieldList(executor: DbOrTx): Promise<{ key: string; group: string; label: string }[]> {
  const out: { key: string; group: string; label: string }[] = [];
  const firstOf = async (type: string) => (await executor.selectFrom("form").select(["id", "title"]).where("type", "=", type).orderBy("id").executeTakeFirst()) ?? null;
  const forms: { id: number; title: string; group: string }[] = [];
  const u = await firstOf("U");
  if (u) forms.push({ ...u, group: "user" });
  const t = await firstOf("T");
  if (t) forms.push({ ...t, group: "ticket" });
  const o = await firstOf("O");
  if (o) forms.push({ ...o, group: "organization" });
  for (const g of await executor.selectFrom("form").select(["id", "title"]).where("type", "=", FormType.GENERIC).orderBy("id").execute()) forms.push({ ...g, group: "custom" });
  for (const form of forms) {
    const fields = await executor.selectFrom("form_field").select(["id", "type", "label"]).where("form_id", "=", form.id).orderBy("sort").orderBy("id").execute();
    for (const f of fields) {
      if (f.type === "break" || f.type === "info") continue;
      const label = form.group === "custom" ? `${form.title} / ${f.label}` : f.label;
      out.push({ key: `field.${f.id}`, group: form.group, label });
      const listId = Number(/^list-(\d+)$/.exec(f.type)?.[1] ?? 0);
      if (listId) {
        out.push({ key: `field.${f.id}.abb`, group: form.group, label: `${label} / [Abbrev]` });
        const props = await executor.selectFrom("form").select("id").where("type", "=", `L${listId}`).executeTakeFirst();
        if (props)
          for (const p of await executor.selectFrom("form_field").select(["id", "label"]).where("form_id", "=", props.id).orderBy("sort").orderBy("id").execute())
            out.push({ key: `field.${f.id}.${p.id}`, group: form.group, label: `${label} / ${p.label}` });
      }
    }
  }
  return out;
}

/** preg_match($pattern, ' ') !== false: delimitatori, modificatori e corpo compilabile (approssimato in JS). */
function pregValid(pattern: string): boolean {
  const m = /^\s*([^a-zA-Z0-9\\\s])/.exec(pattern);
  if (!m) return false;
  const open = m[1];
  const close = { "(": ")", "{": "}", "[": "]", "<": ">" }[open] ?? open;
  const start = pattern.indexOf(open) + 1;
  const end = pattern.lastIndexOf(close);
  if (end < start) return false;
  const body = pattern.slice(start, end);
  const mods = pattern.slice(end + 1);
  if (!/^[imsxuADSUXJn\s\n]*$/.test(mods)) return false;
  if (close === open && open !== "/" && body.includes(open) && !body.includes(`\\${open}`)) return false;
  if (open === "/" && /(^|[^\\])\//.test(body)) return false;
  try {
    new RegExp(body.replace(/\(\?<([a-zA-Z])/g, "(?<$1"), mods.includes("u") ? "u" : "");
    return true;
  } catch {
    try {
      new RegExp(body);
      return true;
    } catch {
      return false;
    }
  }
}

interface RuleInput {
  w: PhpVal;
  h: PhpVal;
  v: PhpVal;
}

/** Filter::validate_rules */
export async function validateRules(ctx: FilterCtx, rulesVar: PhpVal | RuleInput[], errors: Errors): Promise<{ what: string; how: string; val: string }[]> {
  const matches = await supportedMatchFields(ctx);
  const rules: { what: string; how: string; val: string }[] = [];
  const entries: [string, PhpVal][] = Array.isArray(rulesVar)
    ? rulesVar.map((r, i) => [String(i), r as unknown as PhpVal])
    : rulesVar && typeof rulesVar === "object"
      ? Object.entries(rulesVar)
      : [];
  for (const [i, raw] of entries) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const rule = raw as Record<string, PhpVal>;
    let v = rule.v;
    if (!truthy(rule.w) && !truthy(rule.h)) {
      if (truthy(v)) errors[`rule_${i}`] = "incomplete";
      continue;
    }
    const how = str(rule.h);
    if (how === "match" || how === "not_match") {
      const wrapped = `/${str(v)}/iu`;
      if (!pregValid(str(v)) && pregValid(wrapped)) v = wrapped;
    }
    if (!truthy(rule.w) || !matches.has(str(rule.w))) errors[`rule_${i}`] = "invalid_match";
    else if (!truthy(rule.h) || !(MATCH_TYPES as readonly string[]).includes(how)) errors[`rule_${i}`] = "invalid_match_type";
    else if (!truthy(v)) errors[`rule_${i}`] = "value_required";
    else if (str(rule.w) === "email" && how === "equal" && !isEmail(str(v))) errors[`rule_${i}`] = "valid_email_required";
    else if ((how === "match" || how === "not_match") && !pregValid(str(v))) errors[`rule_${i}`] = "regex_error";
    else rules.push({ what: str(rule.w), how, val: str(v).trim() });
  }
  if (!rules.length && !Object.keys(errors).length) errors.rules = "rule_required";
  return rules;
}

/** Filter::save_rules: sostituzione completa delle regole. */
export async function saveRules(ctx: FilterCtx, filterId: number, rulesVar: PhpVal | RuleInput[]): Promise<boolean> {
  const xerrors: Errors = {};
  const rules = await validateRules(ctx, rulesVar, xerrors);
  if (Object.keys(xerrors).length) return false;
  await ctx.executor.deleteFrom("filter_rule").where("filter_id", "=", filterId).execute();
  for (const r of rules) {
    const row = OrmRow.create("filter_rule", "id", { touchUpdated: true });
    row.set("what", r.what);
    row.set("how", r.how);
    row.set("val", r.val);
    row.set("filter_id", filterId);
    await row.save(ctx.executor);
  }
  return true;
}

export async function dbRules(executor: DbOrTx, filterId: number): Promise<RuleInput[]> {
  const rows = await executor.selectFrom("filter_rule").select(["what", "how", "val"]).where("filter_id", "=", filterId).orderBy("id").execute();
  return rows.map((r) => ({ w: r.what, h: r.how, v: r.val }));
}
