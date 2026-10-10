import "server-only";

import { sql } from "kysely";

import { table, type DbOrTx } from "../../db";
import { sanitizeText } from "../../format/text";
import { htmlcharsVars, inArray, intval, isNumeric, isset, list, str, truthy, type PhpVal, type PhpVars } from "../../php/values";
import { ConfigWriter } from "./config-write";
import { saveCompanyForm, validateCompanyForm } from "./company";
import { installedLanguages } from "./languages";
import { updateAgentsSettings, updateUsersSettings } from "./settings-people";
import { updateTasksSettings, updateTicketsSettings } from "./settings-tickets";
import { isset1, v } from "./settings-util";
import { validate, type Errors, type FieldRule } from "./validator";

/**
 * Impostazioni di sistema: scp/settings.php → OsticketConfig::updateSettings($vars, $errors)
 * (include/class.config.php) con le singole update*Settings. Le chiavi e i valori scritti sono quelli
 * del PHP (namespace "core"), con Config::update = UPDATE solo se il valore cambia (updated=NOW) e
 * INSERT se la chiave manca. `t` seleziona la pagina come il campo nascosto del form.
 * Le sezioni di ticket/task e di agenti/utenti sono in settings-tickets.ts e settings-people.ts.
 *
 * Differenze annotate:
 * - Pagina "pages" (Azienda): il caricamento e l'eliminazione di loghi e sfondi (AttachmentFile)
 *   restano al pannello PHP; qui si sceglie solo quale logo/sfondo esistente usare.
 * - enable_captcha: si assume disponibile l'estensione GD (come nell'installazione PHP di riferimento).
 */
export type SettingsPage = "system" | "tickets" | "tasks" | "agents" | "users" | "pages" | "kb";

interface SettingsResult {
  ok: boolean;
  errors: Errors;
}

/** Backend di archiviazione registrati (FileStorageBackend::allRegistered): solo il DB nel core. */
const STORAGE_BACKENDS = ["D"];

/** OsticketConfig::updateSettings */
export async function updateSettings(executor: DbOrTx, input: PhpVars, opts: { ip: string }): Promise<SettingsResult> {
  const errors: Errors = {};
  const cfg = await ConfigWriter.load(executor, "core");
  let ok = false;
  switch (str(input.t).toLowerCase()) {
    case "system":
      ok = await updateSystemSettings(executor, cfg, input, errors, opts.ip);
      break;
    case "tickets":
      ok = await updateTicketsSettings(executor, cfg, input, errors);
      break;
    case "tasks":
      ok = await updateTasksSettings(executor, cfg, input, errors);
      break;
    case "pages":
      ok = await updatePagesSettings(executor, cfg, input, errors);
      break;
    case "agents":
      ok = await updateAgentsSettings(executor, cfg, input, errors);
      break;
    case "users":
      ok = await updateUsersSettings(executor, cfg, input, errors);
      break;
    case "kb":
      ok = await updateKBSettings(executor, cfg, input, errors);
      break;
    default:
      errors.err = "unknown_option";
  }
  return { ok, errors };
}

async function updateSystemSettings(executor: DbOrTx, cfg: ConfigWriter, input: PhpVars, errors: Errors, ip: string): Promise<boolean> {
  const f: Record<string, FieldRule> = {
    helpdesk_url: { type: "string", required: true, error: "required" },
    helpdesk_title: { type: "string", required: true, error: "required" },
    default_dept_id: { type: "int", required: true, error: "required" },
    autolock_minutes: { type: "int", required: true, error: "required" },
    allow_iframes: { type: "cs-url", error: "invalid" },
    embedded_domain_whitelist: { type: "cs-domain", error: "invalid" },
    acl: { type: "ipaddr", error: "invalid" },
    time_format: { type: "string", required: true, error: "required" },
    date_format: { type: "string", required: true, error: "required" },
    datetime_format: { type: "string", required: true, error: "required" },
    daydatetime_format: { type: "string", required: true, error: "required" },
    default_timezone: { type: "string", required: true, error: "required" },
    system_language: { type: "string", required: true, error: "required" },
  };
  // Format::htmlchars($vars, true)
  const vars = htmlcharsVars(input, true);

  // ACL: l'amministratore non può chiudersi fuori
  if (truthy(vars.acl)) {
    if (!inArray(vars.acl_backend, [0, 2])) {
      const acl = str(vars.acl).replace(/ /g, "").split(",");
      if (!acl.includes(ip)) errors.acl = "lockout";
    }
  } else if (intval(vars.acl_backend) !== 0) errors.acl = "ip_required";

  let storagebk: string | null = null;
  if (isset(vars, "default_storage_bk")) {
    if (STORAGE_BACKENDS.includes(str(vars.default_storage_bk))) storagebk = str(vars.default_storage_bk);
    else errors.default_storage_bk = "invalid";
  }

  if (!validate(f, vars, errors) || Object.keys(errors).length) return false;

  // lingue secondarie installate
  const installed = installedLanguages();
  const langs = [...list(vars.secondary_langs), vars.add_secondary_language].filter((l) => truthy(l) && installed.includes(str(l).toLowerCase()));
  const secondary = langs.map(str).join(",");

  if (storagebk) await cfg.update(executor, "default_storage_bk", storagebk);

  const acl = sanitizeText(str(vars.acl));
  const aclBackend = sanitizeText(String(intval(vars.acl_backend)));
  return cfg.updateAll(executor, {
    isonline: v(vars.isonline),
    helpdesk_title: v(vars.helpdesk_title),
    helpdesk_url: v(vars.helpdesk_url),
    default_dept_id: v(vars.default_dept_id),
    force_https: truthy(vars.force_https) ? "on" : "",
    max_page_size: v(vars.max_page_size),
    log_level: v(vars.log_level),
    log_graceperiod: v(vars.log_graceperiod),
    time_format: v(vars.time_format),
    date_format: v(vars.date_format),
    datetime_format: v(vars.datetime_format),
    daydatetime_format: v(vars.daydatetime_format),
    date_formats: v(vars.date_formats),
    default_timezone: v(vars.default_timezone),
    schedule_id: v(vars.schedule_id),
    default_locale: v(vars.default_locale),
    system_language: v(vars.system_language),
    secondary_langs: secondary,
    max_file_size: v(vars.max_file_size),
    autolock_minutes: v(vars.autolock_minutes),
    enable_avatars: isset1(vars, "enable_avatars"),
    enable_richtext: isset1(vars, "enable_richtext"),
    files_req_auth: isset1(vars, "files_req_auth"),
    allow_iframes: sanitizeText(str(vars.allow_iframes)),
    embedded_domain_whitelist: sanitizeText(str(vars.embedded_domain_whitelist)),
    acl,
    acl_backend: truthy(aclBackend) ? aclBackend : 0,
  });
}

async function updatePagesSettings(executor: DbOrTx, cfg: ConfigWriter, vars: PhpVars, errors: Errors): Promise<boolean> {
  const f: Record<string, FieldRule> = {
    landing_page_id: { type: "int", required: true, error: "required" },
    offline_page_id: { type: "int", required: true, error: "required" },
    "thank-you_page_id": { type: "int", required: true, error: "required" },
  };
  // logo[] e backdrop[] (upload) restano al PHP
  const company = await validateCompanyForm(executor, vars);
  Object.assign(errors, company.errors);
  if (!validate(f, vars, errors) || Object.keys(errors).length) return false;
  await saveCompanyForm(executor, company);
  // delete-logo[] / delete-backdrop[] (AttachmentFile::delete) restano al PHP
  const pick = (x: PhpVal) => (isNumeric(x) && truthy(x) ? v(x) : false);
  return cfg.updateAll(executor, {
    landing_page_id: v(vars.landing_page_id),
    offline_page_id: v(vars.offline_page_id),
    "thank-you_page_id": v(vars["thank-you_page_id"]),
    client_logo_id: pick(vars["selected-logo"]),
    staff_logo_id: pick(vars["selected-logo-scp"]),
    staff_backdrop_id: pick(vars["selected-backdrop"]),
  });
}

async function updateKBSettings(executor: DbOrTx, cfg: ConfigWriter, vars: PhpVars, errors: Errors): Promise<boolean> {
  if (Object.keys(errors).length) return false;
  return cfg.updateAll(executor, {
    enable_kb: isset1(vars, "enable_kb"),
    restrict_kb: isset1(vars, "restrict_kb"),
    enable_premade: isset1(vars, "enable_premade"),
  });
}

/** Config "core" con i default di OsticketConfig, per precompilare i form. */
export async function settingsValues(executor: DbOrTx): Promise<Record<string, string>> {
  const { rows } = await sql<{ key: string; value: string }>`SELECT \`key\`, value FROM ${table("config")} WHERE namespace = 'core'`.execute(executor);
  const { CORE_DEFAULTS } = await import("../../config/config");
  const out: Record<string, string> = {};
  for (const [k, d] of Object.entries(CORE_DEFAULTS)) out[k] = typeof d === "boolean" ? (d ? "1" : "") : String(d);
  for (const r of rows) out[r.key] = r.value;
  return out;
}
