import "server-only";

import type { DbOrTx } from "../../db";
import { ConfigWriter } from "../admin/config-write";
import { isset, str, truthy, type PhpVars } from "../admin/php";
import { validate, type Errors, type FieldRule } from "../admin/validator";
import { isEmail } from "../directory/forms";

/**
 * Impostazioni email: scp/emailsettings.php → OsticketConfig::updateSettings con t=emails →
 * updateEmailsSettings($vars, $errors) (include/class.config.php). Scrive le chiavi del namespace
 * "core" con Config::update (UPDATE solo se il valore cambia, INSERT se la chiave manca).
 * Gli errori sono codici al posto dei messaggi tradotti del PHP.
 */
interface EmailsSettingsResult {
  ok: boolean;
  errors: Errors;
}

const FIELDS: Record<string, FieldRule> = {
  default_template_id: { type: "int", required: true, error: "template_required" },
  default_email_id: { type: "int", required: true, error: "default_email_required" },
  alert_email_id: { type: "int", required: true, error: "selection_required" },
  admin_email: { type: "email", required: true, error: "admin_email_required" },
};

const flag = (vars: PhpVars, k: string) => (isset(vars, k) ? 1 : 0);

export async function updateEmailsSettings(executor: DbOrTx, vars: PhpVars): Promise<EmailsSettingsResult> {
  const errors: Errors = {};
  // updateSettings: `if (!$vars || $errors) return false;`
  if (!Object.keys(vars).length) return { ok: false, errors };

  if (truthy(vars.strip_quoted_reply) && !str(vars.reply_separator).trim()) errors.reply_separator = "reply_separator_required";

  // L'email dell'amministratore non può essere anche un'email di sistema (Email::getIdByEmail)
  if (truthy(vars.admin_email)) {
    const row = await executor.selectFrom("email").select("email_id").where("email", "=", str(vars.admin_email)).executeTakeFirst();
    if (row) errors.admin_email = "admin_email_is_system";
  }

  if (!validate(FIELDS, vars, errors, isEmail) || Object.keys(errors).length) return { ok: false, errors };

  const cfg = await ConfigWriter.load(executor, "core");
  const ok = await cfg.updateAll(executor, {
    default_template_id: str(vars.default_template_id),
    default_email_id: str(vars.default_email_id),
    alert_email_id: str(vars.alert_email_id),
    default_smtp_id: vars.default_smtp_id === undefined ? null : str(vars.default_smtp_id),
    admin_email: str(vars.admin_email),
    verify_email_addrs: flag(vars, "verify_email_addrs"),
    enable_auto_cron: flag(vars, "enable_auto_cron"),
    enable_mail_polling: flag(vars, "enable_mail_polling"),
    strip_quoted_reply: flag(vars, "strip_quoted_reply"),
    use_email_priority: flag(vars, "use_email_priority"),
    accept_unregistered_email: flag(vars, "accept_unregistered_email"),
    add_email_collabs: flag(vars, "add_email_collabs"),
    reply_separator: vars.reply_separator === undefined ? null : str(vars.reply_separator),
    email_attachments: flag(vars, "email_attachments"),
  });
  return { ok, errors };
}

/** Valori correnti per il form (Config::getConfigInfo). */
export async function emailsSettingsValues(executor: DbOrTx): Promise<Record<string, string>> {
  const rows = await executor.selectFrom("config").select(["key", "value"]).where("namespace", "=", "core").execute();
  return Object.fromEntries(rows.map((r) => [r.key, r.value ?? ""]));
}
