import "server-only";

import { FormType } from "@/lib/osticket/object-types";

import type { DbOrTx } from "../../db";
import { phpJsonDecode } from "../../format/php-json";
import { str, type PhpVal } from "../../php/values";

/**
 * Filtri sui ticket in ingresso (include/class.filter.php): selezione dei filtri attivi per target e
 * confronto delle regole. Le azioni dei filtri sono in ticket-filter-actions.ts.
 */

interface FilterRule {
  what: string;
  how: string;
  val: string;
}

export interface FilterAction {
  id: number;
  type: string;
  config: Record<string, unknown>;
}

export interface TicketFilterRow {
  id: number;
  name: string;
  target: string;
  emailId: number;
  matchAllRules: boolean;
  stopOnMatch: boolean;
  rules: FilterRule[];
  actions: FilterAction[];
}

/** Dati del ticket in creazione ($vars del PHP) */
export type TicketVars = Record<string, unknown>;

/** RejectedException */
export class TicketRejected extends Error {
  constructor(
    readonly filterName: string,
    readonly email: string,
  ) {
    super("Ticket rejected by a filter");
  }
}

/** TicketFilter::origin2target */
export function originToTarget(origin: string): string {
  return ({ web: "Web", email: "Email", phone: "Web", staff: "Web", api: "API" } as Record<string, string>)[origin.toLowerCase()] ?? "";
}

/** TicketFilter::getAllActive: attivi, target Any o quello dell'origine, email_id 0 o quella del ticket, per execorder */
export async function loadActiveFilters(executor: DbOrTx, target: string, emailId = 0): Promise<TicketFilterRow[]> {
  let q = executor
    .selectFrom("filter")
    .select(["id", "name", "target", "email_id", "match_all_rules", "stop_onmatch"])
    .where("isactive", "=", 1)
    .where("target", "in", ["Any", target as "Web"]);
  if (emailId) q = q.where("email_id", "in", [0, emailId]);
  const filters = await q.orderBy("execorder").orderBy("id").execute();
  const out: TicketFilterRow[] = [];
  for (const f of filters) {
    // Filter::getRules: tutte le regole del filtro (anche disattivate: il PHP non filtra isactive)
    const rules = await executor.selectFrom("filter_rule").select(["what", "how", "val"]).where("filter_id", "=", f.id).orderBy("id").execute();
    const actions = await executor
      .selectFrom("filter_action")
      .select(["id", "type", "configuration"])
      .where("filter_id", "=", f.id)
      .orderBy("sort")
      .orderBy("id")
      .execute();
    out.push({
      id: f.id,
      name: f.name,
      target: f.target,
      emailId: f.email_id,
      matchAllRules: !!f.match_all_rules,
      stopOnMatch: !!f.stop_onmatch,
      rules: rules.map((r) => ({ what: r.what, how: r.how, val: r.val })),
      actions: actions.map((a) => ({ id: a.id, type: a.type, config: phpJsonDecode<Record<string, unknown>>(a.configuration, {}) ?? {} })),
    });
  }
  return out;
}
/** preg_match con delimitatori PHP (best effort in JS) */
function pregMatch(pattern: string, subject: string): number {
  const m = /^([^a-zA-Z0-9\\\s])([\s\S]*)\1([a-zA-Z]*)$/.exec(pattern) ?? /^\(([\s\S]*)\)([a-zA-Z]*)$/.exec(pattern);
  if (!m) return 0;
  const body = m.length === 4 ? m[2] : m[1];
  const flags = (m.length === 4 ? m[3] : m[2]).replace(/[^imsu]/g, "");
  try {
    return new RegExp(body, flags).test(subject) ? 1 : 0;
  } catch {
    return 0;
  }
}

function ruleMatches(how: string, value: string, val: string): boolean | null {
  const lv = value.toLowerCase();
  const lval = val.toLowerCase();
  switch (how) {
    case "equal":
      return lv === lval;
    case "not_equal":
      return lv !== lval;
    case "contains":
      return lv.includes(lval);
    case "dn_contain":
      return !lv.includes(lval);
    case "starts":
      return lv.startsWith(lval);
    case "ends":
      return val.length === 0 || lv.endsWith(lval);
    case "match":
      return pregMatch(val, value) === 1;
    case "not_match":
      return pregMatch(val, value) !== 1;
    default:
      return null;
  }
}

/** Filter::matches($what) */
export function filterMatches(filter: TicketFilterRow, what: TicketVars): boolean {
  if (filter.emailId && filter.target.toLowerCase() === "email" && filter.emailId !== Number(what.emailId ?? 0)) return false;
  let match = false;
  for (const rule of filter.rules) {
    const r = ruleMatches(rule.how, str(what[rule.what] as PhpVal), rule.val);
    if (r === null) continue;
    if (r) {
      match = true;
      if (!filter.matchAllRules) break;
    } else if (filter.matchAllRules) {
      match = false;
      break;
    }
  }
  return match;
}

/** TicketFilter::__construct: dati confrontabili (body, campi supportati, emailId, addressee) */
export function filterInput(vars: TicketVars): TicketVars {
  const out: TicketVars = { body: vars.message ?? null };
  for (const [k, v] of Object.entries(vars)) {
    if (["name", "email", "reply-to", "reply-to-name", "addressee", "topicId", "emailId"].includes(k) || k.startsWith("field.")) {
      out[k] = str(v as PhpVal).trim();
    }
  }
  const recipients = vars.recipients as { name: string; email: string }[] | undefined;
  if (Array.isArray(recipients) && recipients.length) out.addressee = recipients.flatMap((r) => [r.name, r.email]).join(" ");
  return out;
}

/**
 * Effetto collaterale di `new TicketFilter()` → Filter::getSupportedMatchFields(): i gruppi "User Data",
 * "Ticket Data", "Custom Forms" e "Organization Data" percorrono i campi dei form U, T, G e O e per i
 * campi lista chiamano hasSubFields() → DynamicList::getForm(), che crea il form "L<lista>" delle
 * proprietà se manca. Si replica creando i form mancanti nello stesso ordine.
 */
export async function prepareSupportedMatches(executor: DbOrTx): Promise<void> {
  const { ensureListPropertiesForm } = await import("../forms/entry");
  const firstOf = async (type: string) => (await executor.selectFrom("form").select("id").where("type", "=", type).orderBy("id").executeTakeFirst())?.id;
  const formIds: number[] = [];
  for (const type of ["U", "T"]) {
    const id = await firstOf(type);
    if (id) formIds.push(id);
  }
  formIds.push(...(await executor.selectFrom("form").select("id").where("type", "=", FormType.GENERIC).orderBy("id").execute()).map((f) => f.id));
  const org = await firstOf("O");
  if (org) formIds.push(org);
  for (const formId of formIds) {
    const fields = await executor.selectFrom("form_field").select(["type"]).where("form_id", "=", formId).where("type", "like", "list-%").orderBy("sort").orderBy("id").execute();
    for (const f of fields) {
      const listId = Number(/^list-(\d+)$/.exec(f.type)?.[1] ?? 0);
      if (listId) await ensureListPropertiesForm(executor, listId);
    }
  }
}
