import "server-only";

import { Dept, Filter, Topic } from "@/lib/osticket/flags";

import type { DbOrTx } from "../../db";
import { stripTags } from "../../format/html";
import { phpJsonEncode } from "../../format/php-json";
import { stripEmoticons } from "../../format/text";
import { htmlchars, intval, isArray, isNumeric, list, str, truthy, type PhpVal, type PhpVars } from "../../php/values";
import { OrmRow } from "../admin/orm";
import type { Errors } from "../admin/validator";
import { isFormula, parseAddressList } from "../forms/validator";
import type { FilterCtx } from "./filter-rules";
import { sanitizeHtml as sanitizeText } from "./sanitize";

/**
 * Azioni dei filtri dei ticket (include/class.filter_action.php, Filter::validate_actions e
 * Filter::save_actions): tipi registrati, campi dei form di configurazione, validazione e salvataggio
 * delle righe `filter_action` con la configurazione JSON.
 */

/** Filter::setFlag($flag, $val) sul filtro di un'azione esistente */
type SetFlag = (filterId: number, flag: number, on: boolean) => Promise<void>;

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

async function isActiveRow(executor: DbOrTx, kind: "dept" | "topic", id: PhpVal): Promise<boolean> {
  const n = intval(id ?? null);
  if (!n || (typeof id === "string" && !isNumeric(id))) return false;
  if (kind === "dept") {
    const d = await executor.selectFrom("department").select("flags").where("id", "=", n).executeTakeFirst();
    return !!d && !!(d.flags & Dept.ACTIVE);
  }
  const t = await executor.selectFrom("help_topic").select("flags").where("topic_id", "=", n).executeTakeFirst();
  return !!t && !!((t.flags ?? 0) & Topic.ACTIVE);
}

/** FilterAction::lookup($info) per id (stringa numerica o non). */
async function actionById(executor: DbOrTx, info: PhpVal) {
  if (!isNumeric(info ?? null) || intval(info ?? null) <= 0) return null;
  return (await executor.selectFrom("filter_action").selectAll().where("id", "=", intval(info ?? null)).executeTakeFirst()) ?? null;
}

/**
 * Filter::validate_actions: true, false o 1 (errore su un valore vuoto). `setFlag` è Filter::setFlag del
 * filtro (filter.ts), che riesegue Filter::update e quindi di nuovo questa validazione.
 */
export async function validateActions(ctx: FilterCtx, vars: PhpVars, errors: Errors, setFlag: SetFlag): Promise<boolean | null | 1> {
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
      for (const flag of [Filter.DELETED_OBJECT, Filter.INACTIVE_DEPT, Filter.INACTIVE_HT]) await setFlag(fa.filter_id, flag, false);
    }
  }
  return !Object.keys(errors).length;
}

/** Filter::save_actions */
export async function saveActions(ctx: FilterCtx, filterId: number, vars: PhpVars, errors: Errors): Promise<void> {
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
