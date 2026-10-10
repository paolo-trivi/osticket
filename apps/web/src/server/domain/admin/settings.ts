import "server-only";

import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { sql } from "kysely";

import { CustomQueue, Topic } from "@/lib/osticket/flags";

import { NOW, table, type DbOrTx } from "../../db";
import { sanitizeText } from "../../format/text";
import { htmlcharsVars, inArray, intval, isNumeric, isset, list, phpLooseEquals, str, truthy, type PhpVal, type PhpVars } from "../../php/values";
import { hasHash } from "./common";
import { ConfigWriter, type ConfigValue } from "./config-write";
import { saveCompanyForm, validateCompanyForm } from "./company";
import { validate, type Errors, type FieldRule } from "./validator";

/**
 * Impostazioni di sistema: scp/settings.php → OsticketConfig::updateSettings($vars, $errors)
 * (include/class.config.php) con le singole update*Settings. Le chiavi e i valori scritti sono quelli
 * del PHP (namespace "core"), con Config::update = UPDATE solo se il valore cambia (updated=NOW) e
 * INSERT se la chiave manca. `t` seleziona la pagina come il campo nascosto del form.
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
/** Sorgenti avatar registrate (AvatarSource::register): local, gravatar. */
const AVATAR_SOURCES = ["local", "gravatar"];

/** Internationalization::availableLanguages(): cartelle e .phar in include/i18n dell'installazione PHP. */
export function installedLanguages(): string[] {
  const cfgPath = process.env.OST_CONFIG_PATH;
  const out = new Set<string>();
  if (cfgPath) {
    const dir = join(dirname(cfgPath), "i18n");
    try {
      if (existsSync(dir))
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (e.isDirectory() && /^[a-z]{2}(_[A-Za-z0-9]+)?$/.test(e.name)) out.add(e.name.toLowerCase());
          else if (e.isFile() && e.name.endsWith(".phar")) out.add(e.name.slice(0, -5).toLowerCase());
        }
    } catch {
      /* cartella non leggibile: solo la lingua di base */
    }
  }
  if (!out.size) out.add("en_us");
  return [...out];
}

const isset1 = (vars: PhpVars, k: string) => (isset(vars, k) ? 1 : 0);

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

/** Valore scalare di una variabile per Config::update (gli array non sono previsti nei form). */
function v(x: PhpVal): ConfigValue {
  if (x === undefined || x === null) return null;
  if (Array.isArray(x) || typeof x === "object") return "Array";
  return x;
}

async function updateAgentsSettings(executor: DbOrTx, cfg: ConfigWriter, vars: PhpVars, errors: Errors): Promise<boolean> {
  const f: Record<string, FieldRule> = {
    staff_session_timeout: { type: "int", required: true, error: "required" },
    pw_reset_window: { type: "int", required: true, min: 1, error: "invalid" },
  };
  const [avatar] = str(vars.agent_avatar).split(".");
  if (!AVATAR_SOURCES.includes(avatar)) errors.agent_avatar = "invalid";
  if (!validate(f, vars, errors) || Object.keys(errors).length) return false;
  return cfg.updateAll(executor, {
    agent_passwd_policy: v(vars.agent_passwd_policy),
    staff_max_logins: v(vars.staff_max_logins),
    staff_login_timeout: v(vars.staff_login_timeout),
    staff_session_timeout: v(vars.staff_session_timeout),
    staff_ip_binding: isset1(vars, "staff_ip_binding"),
    allow_pw_reset: isset1(vars, "allow_pw_reset"),
    pw_reset_window: v(vars.pw_reset_window),
    require_agent_2fa: isset1(vars, "require_agent_2fa"),
    agent_name_format: v(vars.agent_name_format),
    hide_staff_name: isset1(vars, "hide_staff_name"),
    agent_avatar: v(vars.agent_avatar),
    disable_agent_collabs: isset1(vars, "disable_agent_collabs"),
  });
}

async function updateUsersSettings(executor: DbOrTx, cfg: ConfigWriter, vars: PhpVars, errors: Errors): Promise<boolean> {
  const f: Record<string, FieldRule> = {
    client_session_timeout: { type: "int", required: true, error: "required" },
  };
  const [avatar] = str(vars.client_avatar).split(".");
  if (!AVATAR_SOURCES.includes(avatar)) errors.client_avatar = "invalid";
  if (!validate(f, vars, errors) || Object.keys(errors).length) return false;
  return cfg.updateAll(executor, {
    client_passwd_policy: v(vars.client_passwd_policy),
    client_max_logins: v(vars.client_max_logins),
    client_login_timeout: v(vars.client_login_timeout),
    client_session_timeout: v(vars.client_session_timeout),
    clients_only: isset1(vars, "clients_only"),
    client_registration: v(vars.client_registration),
    client_verify_email: isset1(vars, "client_verify_email"),
    allow_auth_tokens: isset1(vars, "allow_auth_tokens"),
    client_name_format: v(vars.client_name_format),
    client_avatar: v(vars.client_avatar),
  });
}

async function updateTicketsSettings(executor: DbOrTx, cfg: ConfigWriter, vars: PhpVars, errors: Errors): Promise<boolean> {
  const f: Record<string, FieldRule> = {
    default_sla_id: { type: "int", required: true, error: "required" },
    default_ticket_status_id: { type: "int", required: true, error: "required" },
    default_priority_id: { type: "int", required: true, error: "required" },
    max_open_tickets: { type: "int", required: true, error: "invalid" },
  };
  // enable_captcha richiede GD/PNG: disponibili nell'installazione PHP di riferimento

  if (truthy(vars.default_help_topic)) {
    const t = await executor.selectFrom("help_topic").select("flags").where("topic_id", "=", intval(vars.default_help_topic)).executeTakeFirst();
    if (t && !((t.flags ?? 0) & Topic.ACTIVE)) errors.default_help_topic = "inactive";
  }
  if (!hasHash(vars.ticket_number_format)) errors.ticket_number_format = "hash";
  if (!isset(vars, "default_ticket_queue")) errors.default_ticket_queue = "required";
  else if (!(isNumeric(vars.default_ticket_queue) && (await executor.selectFrom("queue").select("id").where("id", "=", intval(vars.default_ticket_queue)).executeTakeFirst())))
    errors.default_ticket_queue = "required";

  // NB: autorisposte e avvisi si salvano subito, anche se poi la validazione dei campi fallisce
  await updateAutoresponderSettings(executor, cfg, vars, errors);
  await updateAlertsSettings(executor, cfg, vars, errors);

  if (!validate(f, vars, errors) || Object.keys(errors).length) return false;

  // Ordinamento delle code (qsort[queue_id] = sort) tra le code con FLAG_QUEUE
  const qsort = vars.qsort;
  if (qsort && typeof qsort === "object" && !Array.isArray(qsort)) {
    for (const [qid, sort] of Object.entries(qsort)) {
      const q = await executor.selectFrom("queue").select(["id", "sort"]).where("id", "=", intval(qid)).where(sql<boolean>`(flags & ${sql.lit(CustomQueue.QUEUE)}) != 0`).executeTakeFirst();
      if (!q) continue;
      if (phpLooseEquals(q.sort, sort as never)) continue;
      await executor.updateTable("queue").set({ sort: intval(sort), updated: NOW }).where("id", "=", q.id).execute();
    }
  }

  return cfg.updateAll(executor, {
    ticket_number_format: truthy(vars.ticket_number_format) ? v(vars.ticket_number_format) : "######",
    ticket_sequence_id: truthy(vars.ticket_sequence_id) ? v(vars.ticket_sequence_id) : 0,
    queue_bucket_counts: isset1(vars, "queue_bucket_counts"),
    default_priority_id: v(vars.default_priority_id),
    default_help_topic: v(vars.default_help_topic),
    default_ticket_status_id: v(vars.default_ticket_status_id),
    default_sla_id: v(vars.default_sla_id),
    max_open_tickets: v(vars.max_open_tickets),
    enable_captcha: isset1(vars, "enable_captcha"),
    auto_claim_tickets: isset1(vars, "auto_claim_tickets"),
    auto_refer_closed: isset1(vars, "auto_refer_closed"),
    collaborator_ticket_visibility: isset1(vars, "collaborator_ticket_visibility"),
    require_topic_to_close: isset1(vars, "require_topic_to_close"),
    show_related_tickets: isset1(vars, "show_related_tickets"),
    allow_client_updates: isset1(vars, "allow_client_updates"),
    ticket_lock: v(vars.ticket_lock),
    default_ticket_queue: v(vars.default_ticket_queue),
    allow_external_images: isset1(vars, "allow_external_images"),
  });
}

/** Controllo "Select recipient(s)": l'avviso attivo richiede almeno un destinatario. */
function needRecipients(vars: PhpVars, errors: Errors, active: string, keys: string[]): void {
  if (truthy(vars[active]) && !keys.some((k) => isset(vars, k))) errors[active] = "recipients";
}

async function updateTasksSettings(executor: DbOrTx, cfg: ConfigWriter, vars: PhpVars, errors: Errors): Promise<boolean> {
  const f: Record<string, FieldRule> = {
    default_task_priority_id: { type: "int", required: true, error: "required" },
  };
  if (!hasHash(vars.task_number_format)) errors.task_number_format = "hash";
  validate(f, vars, errors);
  needRecipients(vars, errors, "task_alert_active", ["task_alert_admin", "task_alert_dept_manager", "task_alert_dept_members", "task_alert_acct_manager"]);
  needRecipients(vars, errors, "task_activity_alert_active", ["task_activity_alert_laststaff", "task_activity_alert_assigned", "task_activity_alert_dept_manager"]);
  needRecipients(vars, errors, "task_transfer_alert_active", ["task_transfer_alert_assigned", "task_transfer_alert_dept_manager", "task_transfer_alert_dept_members"]);
  needRecipients(vars, errors, "task_overdue_alert_active", ["task_overdue_alert_assigned", "task_overdue_alert_dept_manager", "task_overdue_alert_dept_members"]);
  needRecipients(vars, errors, "task_assignment_alert_active", ["task_assignment_alert_staff", "task_assignment_alert_team_lead", "task_assignment_alert_team_members"]);
  if (Object.keys(errors).length) return false;
  return cfg.updateAll(executor, {
    task_number_format: truthy(vars.task_number_format) ? v(vars.task_number_format) : "######",
    task_sequence_id: truthy(vars.task_sequence_id) ? v(vars.task_sequence_id) : 0,
    default_task_priority_id: v(vars.default_task_priority_id),
    default_task_sla_id: v(vars.default_task_sla_id),
    task_alert_active: v(vars.task_alert_active),
    task_alert_admin: isset1(vars, "task_alert_admin"),
    task_alert_dept_manager: isset1(vars, "task_alert_dept_manager"),
    task_alert_dept_members: isset1(vars, "task_alert_dept_members"),
    task_activity_alert_active: v(vars.task_activity_alert_active),
    task_activity_alert_laststaff: isset1(vars, "task_activity_alert_laststaff"),
    task_activity_alert_assigned: isset1(vars, "task_activity_alert_assigned"),
    task_activity_alert_dept_manager: isset1(vars, "task_activity_alert_dept_manager"),
    task_assignment_alert_active: v(vars.task_assignment_alert_active),
    task_assignment_alert_staff: isset1(vars, "task_assignment_alert_staff"),
    task_assignment_alert_team_lead: isset1(vars, "task_assignment_alert_team_lead"),
    task_assignment_alert_team_members: isset1(vars, "task_assignment_alert_team_members"),
    task_transfer_alert_active: v(vars.task_transfer_alert_active),
    task_transfer_alert_assigned: isset1(vars, "task_transfer_alert_assigned"),
    task_transfer_alert_dept_manager: isset1(vars, "task_transfer_alert_dept_manager"),
    task_transfer_alert_dept_members: isset1(vars, "task_transfer_alert_dept_members"),
    task_overdue_alert_active: v(vars.task_overdue_alert_active),
    task_overdue_alert_assigned: isset1(vars, "task_overdue_alert_assigned"),
    task_overdue_alert_dept_manager: isset1(vars, "task_overdue_alert_dept_manager"),
    task_overdue_alert_dept_members: isset1(vars, "task_overdue_alert_dept_members"),
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

async function updateAutoresponderSettings(executor: DbOrTx, cfg: ConfigWriter, vars: PhpVars, errors: Errors): Promise<boolean> {
  if (Object.keys(errors).length) return false;
  return cfg.updateAll(executor, {
    ticket_autoresponder: isset1(vars, "ticket_autoresponder"),
    message_autoresponder: isset1(vars, "message_autoresponder"),
    message_autoresponder_collabs: isset1(vars, "message_autoresponder_collabs"),
    ticket_notice_active: isset1(vars, "ticket_notice_active"),
    overlimit_notice_active: isset1(vars, "overlimit_notice_active"),
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

async function updateAlertsSettings(executor: DbOrTx, cfg: ConfigWriter, vars: PhpVars, errors: Errors): Promise<boolean> {
  needRecipients(vars, errors, "ticket_alert_active", ["ticket_alert_admin", "ticket_alert_dept_manager", "ticket_alert_dept_members", "ticket_alert_acct_manager"]);
  needRecipients(vars, errors, "message_alert_active", ["message_alert_laststaff", "message_alert_assigned", "message_alert_dept_manager", "message_alert_acct_manager"]);
  needRecipients(vars, errors, "note_alert_active", ["note_alert_laststaff", "note_alert_assigned", "note_alert_dept_manager"]);
  needRecipients(vars, errors, "transfer_alert_active", ["transfer_alert_assigned", "transfer_alert_dept_manager", "transfer_alert_dept_members"]);
  needRecipients(vars, errors, "overdue_alert_active", ["overdue_alert_assigned", "overdue_alert_dept_manager", "overdue_alert_dept_members"]);
  needRecipients(vars, errors, "assigned_alert_active", ["assigned_alert_staff", "assigned_alert_team_lead", "assigned_alert_team_members"]);
  if (Object.keys(errors).length) return false;
  return cfg.updateAll(executor, {
    ticket_alert_active: v(vars.ticket_alert_active),
    ticket_alert_admin: isset1(vars, "ticket_alert_admin"),
    ticket_alert_dept_manager: isset1(vars, "ticket_alert_dept_manager"),
    ticket_alert_dept_members: isset1(vars, "ticket_alert_dept_members"),
    ticket_alert_acct_manager: isset1(vars, "ticket_alert_acct_manager"),
    message_alert_active: v(vars.message_alert_active),
    message_alert_laststaff: isset1(vars, "message_alert_laststaff"),
    message_alert_assigned: isset1(vars, "message_alert_assigned"),
    message_alert_dept_manager: isset1(vars, "message_alert_dept_manager"),
    message_alert_acct_manager: isset1(vars, "message_alert_acct_manager"),
    note_alert_active: v(vars.note_alert_active),
    note_alert_laststaff: isset1(vars, "note_alert_laststaff"),
    note_alert_assigned: isset1(vars, "note_alert_assigned"),
    note_alert_dept_manager: isset1(vars, "note_alert_dept_manager"),
    assigned_alert_active: v(vars.assigned_alert_active),
    assigned_alert_staff: isset1(vars, "assigned_alert_staff"),
    assigned_alert_team_lead: isset1(vars, "assigned_alert_team_lead"),
    assigned_alert_team_members: isset1(vars, "assigned_alert_team_members"),
    transfer_alert_active: v(vars.transfer_alert_active),
    transfer_alert_assigned: isset1(vars, "transfer_alert_assigned"),
    transfer_alert_dept_manager: isset1(vars, "transfer_alert_dept_manager"),
    transfer_alert_dept_members: isset1(vars, "transfer_alert_dept_members"),
    overdue_alert_active: v(vars.overdue_alert_active),
    overdue_alert_assigned: isset1(vars, "overdue_alert_assigned"),
    overdue_alert_dept_manager: isset1(vars, "overdue_alert_dept_manager"),
    overdue_alert_dept_members: isset1(vars, "overdue_alert_dept_members"),
    send_sys_errors: isset1(vars, "send_sys_errors"),
    send_sql_errors: isset1(vars, "send_sql_errors"),
    send_login_errors: isset1(vars, "send_login_errors"),
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

