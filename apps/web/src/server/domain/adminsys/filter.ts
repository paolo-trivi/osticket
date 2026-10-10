import "server-only";

import type { DbOrTx } from "../../db";
import { stripTags } from "../../format/html";
import { phpJsonEncode } from "../../format/php-json";
import { stripEmoticons } from "../../format/text";
import { htmlchars, intval, isArray, isNumeric, list, phpLooseEquals, str, truthy, type PhpVal, type PhpVars } from "../../php/values";
import { sanitizeHtml as sanitizeText } from "./sanitize";
import type { MassResult, SaveResult } from "../admin/common";
import { DeptFlag } from "../admin/dept";
import { OrmRow, SQL_NOW } from "../admin/orm";
import { ov, pv } from "./orm-util";
import { TopicFlag } from "../admin/topic";
import type { Errors } from "../admin/validator";
import { isEmail, isFormula, parseAddressList } from "../forms/validator";
import { prepareSupportedMatches } from "../filter/ticket-filter";

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
 * La ban list di sistema ("SYSTEM BAN LIST") ha la sua pagina e qui non si modifica.
 */
export const FilterFlag = { INACTIVE_HT: 0x0001, INACTIVE_DEPT: 0x0002, DELETED_OBJECT: 0x0004 } as const;

export const MATCH_TYPES = ["equal", "not_equal", "contains", "dn_contain", "starts", "ends", "match", "not_match"] as const;
export const TARGETS = ["Any", "Web", "API", "Email"] as const;

/** Gruppi di azioni registrati (FilterAction::allRegistered), nell'ordine di registrazione. */
export const ACTION_TYPES: { type: string; group: "Ticket" | "Communication"; multi?: boolean }[] = [
  { type: "reject", group: "Ticket" },
  { type: "replyto", group: "Communication" },
  { type: "noresp", group: "Communication" },
  { type: "canned", group: "Communication" },
  { type: "dept", group: "Ticket" },
  { type: "pri", group: "Ticket" },
  { type: "sla", group: "Ticket" },
  { type: "team", group: "Ticket" },
  { type: "agent", group: "Ticket" },
  { type: "topic", group: "Ticket" },
  { type: "status", group: "Ticket" },
  { type: "email", group: "Communication", multi: true },
];

interface ActionField {
  name: string;
  kind: "choice" | "text" | "html";
  required?: boolean;
  /** validatori del campo (codice d'errore o null) */
  check?: (clean: PhpVal) => string | null;
  /** valore di default del campo ChoiceField (from: email predefinita) */
  defaultFrom?: "default_email";
}

const notNew = (code: string) => (clean: PhpVal) => (clean === ":new:" ? code : null);

/** Campi dei form di configurazione delle azioni (TriggerAction::getConfigurationOptions). */
export const ACTION_FIELDS: Record<string, ActionField[]> = {
  reject: [],
  replyto: [],
  noresp: [],
  canned: [{ name: "canned_id", kind: "choice" }],
  dept: [{ name: "dept_id", kind: "choice", check: notNew("select_dept") }],
  pri: [{ name: "priority", kind: "choice" }],
  sla: [{ name: "sla_id", kind: "choice" }],
  team: [{ name: "team_id", kind: "choice", check: notNew("select_team") }],
  agent: [{ name: "staff_id", kind: "choice" }],
  topic: [{ name: "topic_id", kind: "choice" }],
  status: [{ name: "status_id", kind: "choice" }],
  email: [
    { name: "recipients", kind: "text", required: true, check: recipientsError },
    { name: "subject", kind: "text", required: true },
    { name: "message", kind: "html", required: true },
    { name: "from", kind: "choice", defaultFrom: "default_email" },
  ],
};

/**
 * Validatore dei destinatari di FA_SendEmail: Mail_Parse::parseAddressList (Mail_RFC822 senza
 * validazione degli atomi, lista vuota per un valore "falso"), poi segnaposto `%{user}` o indirizzo con
 * mailbox e host diverso da "localhost". Riceve il valore già passato da htmlchars, come il PHP.
 */
function recipientsError(value: PhpVal): string | null {
  const mails = truthy(value) ? parseAddressList(str(value), { validate: false }) : [];
  if (!mails?.length) return "address_list";
  for (const M of mails) {
    const ph = /%\{([^}]+)\}/.exec(M.mailbox);
    if (ph) {
      if (ph[1] !== "user") return "invalid_variable";
    } else if (M.host === "localhost" || !truthy(M.mailbox)) return "invalid_address";
  }
  return null;
}

/** ChoiceField: widget → parse → to_php (i valori numerici diventano numeri, come JsonDataParser). */
function choiceClean(raw: PhpVal): PhpVal {
  if (!truthy(raw) || typeof raw === "object") return null;
  const s = str(raw);
  try {
    const v = JSON.parse(s) as unknown;
    if (v !== null && v !== false && v !== 0 && v !== "" && (typeof v === "number" || typeof v === "string" || typeof v === "boolean")) return v as PhpVal;
  } catch {
    /* non JSON: stringa */
  }
  return s;
}

/** FilterAction::parseConfiguration: configurazione e errori dei campi (codici). */
async function parseConfiguration(executor: DbOrTx, type: string, vars: PhpVars): Promise<{ config: Record<string, PhpVal>; errors: string[] }> {
  const config: Record<string, PhpVal> = {};
  const errors: string[] = [];
  for (const f of ACTION_FIELDS[type] ?? []) {
    const raw = vars[f.name];
    let clean: PhpVal;
    if (f.kind === "choice") {
      clean = choiceClean(raw);
      if ((clean === null || clean === undefined) && f.defaultFrom) {
        const def = await executor.selectFrom("config").select("value").where("namespace", "=", "core").where("key", "=", "default_email_id").executeTakeFirst();
        if (truthy(def?.value)) clean = choiceClean(def?.value ?? null);
      }
    } else if (f.kind === "text") {
      clean = stripEmoticons(stripTags(str(raw)));
    } else {
      clean = sanitizeText(str(raw));
    }
    // FormField::validateEntry: required, poi i validatori dichiarati; TextboxField li riceve con
    // htmlchars ('0' → '&#48') e aggiunge il validatore "formula"
    const value: PhpVal = f.kind === "text" ? (clean === "0" ? "&#48" : str(htmlchars(str(clean)))) : clean;
    if (f.required && !truthy(value)) errors.push("required");
    const e = f.check?.(value);
    if (e) errors.push(e);
    if (f.kind === "text" && truthy(value) && !isFormula(str(value))) errors.push("formula");
    config[f.name] = clean;
  }
  return { config, errors };
}

const encodeConfig = (config: Record<string, PhpVal>) => (Object.keys(config).length ? phpJsonEncode(config) : "[]");

/** Stato di un salvataggio in corso: errori condivisi come l'array $errors passato per riferimento. */
interface Ctx {
  executor: DbOrTx;
  matchFields?: Set<string>;
}

/** Filter::getSupportedMatchFields (con gli effetti collaterali sui form delle liste). */
async function supportedMatchFields(ctx: Ctx): Promise<Set<string>> {
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
  for (const g of await executor.selectFrom("form").select(["id", "title"]).where("type", "=", "G").orderBy("id").execute()) forms.push({ ...g, group: "custom" });
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
async function validateRules(ctx: Ctx, rulesVar: PhpVal | RuleInput[], errors: Errors): Promise<{ what: string; how: string; val: string }[]> {
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
async function saveRules(ctx: Ctx, filterId: number, rulesVar: PhpVal | RuleInput[]): Promise<boolean> {
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

async function dbRules(executor: DbOrTx, filterId: number): Promise<RuleInput[]> {
  const rows = await executor.selectFrom("filter_rule").select(["what", "how", "val"]).where("filter_id", "=", filterId).orderBy("id").execute();
  return rows.map((r) => ({ w: r.what, h: r.how, v: r.val }));
}

async function isActiveRow(executor: DbOrTx, kind: "dept" | "topic", id: PhpVal): Promise<boolean> {
  const n = intval(id ?? null);
  if (!n || (typeof id === "string" && !isNumeric(id))) return false;
  if (kind === "dept") {
    const d = await executor.selectFrom("department").select("flags").where("id", "=", n).executeTakeFirst();
    return !!d && !!(d.flags & DeptFlag.ACTIVE);
  }
  const t = await executor.selectFrom("help_topic").select("flags").where("topic_id", "=", n).executeTakeFirst();
  return !!t && !!((t.flags ?? 0) & TopicFlag.ACTIVE);
}

/** FilterAction::lookup($info) per id (stringa numerica o non). */
async function actionById(executor: DbOrTx, info: PhpVal) {
  if (!isNumeric(info ?? null) || intval(info ?? null) <= 0) return null;
  return (await executor.selectFrom("filter_action").selectAll().where("id", "=", intval(info ?? null)).executeTakeFirst()) ?? null;
}

/** Filter::validate_actions: true, false o 1 (errore su un valore vuoto). */
async function validateActions(ctx: Ctx, vars: PhpVars, errors: Errors): Promise<boolean | null | 1> {
  if (truthy(vars.pass)) return true;
  if (!isArray(vars.actions)) return null;
  let info: PhpVal = null;
  for (const v of list(vars.actions)) {
    const sv = str(v);
    info = sv.slice(1);
    let type = str(info);
    if (isNumeric(info)) {
      const a = await actionById(ctx.executor, info);
      if (!a) continue;
      type = a.type;
    }
    const parsed = await parseConfiguration(ctx.executor, type, vars);
    const config: Record<string, PhpVal> | null = parsed.errors.length ? null : parsed.config;
    let display = str(info);
    if (isNumeric(info) && config) {
      // tipo "visualizzato" dalle chiavi della configurazione (solo dept/topic contano)
      for (const key of Object.keys(config)) display = key === "topic_id" ? "topic" : key === "dept_id" ? "dept" : "other";
    }
    if (sv.slice(0, 1) !== "D") {
      if (display === "dept") {
        if (!(await isActiveRow(ctx.executor, "dept", config?.dept_id ?? null))) errors.err = "inactive_dept";
      } else if (display === "topic") {
        if (!(await isActiveRow(ctx.executor, "topic", config?.topic_id ?? null))) errors.err = "inactive_topic";
      } else {
        for (const value of Object.values(config ?? {})) {
          if (!truthy(value)) {
            errors.err = "action_value_required";
            return 1;
          }
        }
      }
    }
  }
  if (!Object.keys(errors).length) {
    const fa = await actionById(ctx.executor, info);
    if (fa) {
      // Filter::setFlag(...) ×3: ognuna esegue update() sui dati del modello (e ricrea le regole)
      for (const flag of [FilterFlag.DELETED_OBJECT, FilterFlag.INACTIVE_DEPT, FilterFlag.INACTIVE_HT]) await setFlag(ctx, fa.filter_id, flag, false);
    }
  }
  return !Object.keys(errors).length;
}

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
async function setFlag(ctx: Ctx, filterId: number, flag: number, on: boolean): Promise<void> {
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

/** Filter::save_actions */
async function saveActions(ctx: Ctx, filterId: number, vars: PhpVars, errors: Errors): Promise<void> {
  if (!isArray(vars.actions)) return;
  const entries = Array.isArray(vars.actions) ? vars.actions.map((v, i) => [i, v] as const) : Object.entries(vars.actions as Record<string, PhpVal>);
  for (const [sort, v] of entries) {
    const sv = str(v);
    const action = sv.slice(0, 1);
    const info = sv.slice(1);
    const setConfiguration = async (row: OrmRow, type: string) => {
      const parsed = await parseConfiguration(ctx.executor, type, vars);
      // array_merge($errors, $field->errors()): chiavi numeriche rinumerate in coda
      const base = Object.keys(errors).filter((k) => /^\d+$/.test(k)).length;
      parsed.errors.forEach((e, i) => (errors[String(base + i)] = e));
      if (!Object.keys(errors).length) row.set("configuration", encodeConfig(parsed.config));
    };
    if (action === "N") {
      const row = OrmRow.create("filter_action", "id", { touchUpdated: true });
      row.set("type", info);
      row.set("filter_id", filterId);
      row.set("sort", intval(sort));
      await setConfiguration(row, info);
      await row.save(ctx.executor);
    } else if (action === "I") {
      const a = await actionById(ctx.executor, info);
      if (!a) continue;
      const row = OrmRow.from("filter_action", "id", a as unknown as Record<string, unknown>, { touchUpdated: true });
      await setConfiguration(row, a.type);
      row.set("sort", intval(sort));
      await row.save(ctx.executor);
    } else if (action === "D") {
      const a = await actionById(ctx.executor, info);
      if (a) await ctx.executor.deleteFrom("filter_action").where("id", "=", a.id).execute();
    }
  }
}

/** Filter::update($vars, $errors) */
async function filterUpdate(ctx: Ctx, filter: OrmRow, vars: PhpVars, errors: Errors): Promise<boolean> {
  if (!(await validateActions(ctx, vars, errors))) return false;
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
  const ctx: Ctx = { executor };
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
