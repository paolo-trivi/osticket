import "server-only";

import { isKnownOrCurrent } from "@/lib/admin/current-value";

import type { DbOrTx } from "../../db";
import { str, type PhpVars } from "../../php/values";
import type { ConfigWriter } from "./config-write";
import { isset1, v } from "./settings-util";
import { validate, type Errors, type FieldRule } from "./validator";

/** Impostazioni di agenti e utenti: OsticketConfig::updateAgentsSettings / updateUsersSettings. */

/**
 * Sorgenti avatar registrate nel core (AvatarSource::register): local, gravatar. Una sorgente di un
 * plugin è registrata solo nel PHP: il valore attuale resta ammesso se non viene cambiato.
 */
const AVATAR_SOURCES = ["local", "gravatar"];

/** AvatarSource::lookup($source) oppure valore attuale invariato */
const validAvatar = (value: string, current: string | null | undefined) => AVATAR_SOURCES.includes(value.split(".")[0]) || isKnownOrCurrent(value, [], current);

/** OsticketConfig::updateAgentsSettings */
export async function updateAgentsSettings(executor: DbOrTx, cfg: ConfigWriter, vars: PhpVars, errors: Errors): Promise<boolean> {
  const f: Record<string, FieldRule> = {
    staff_session_timeout: { type: "int", required: true, error: "required" },
    pw_reset_window: { type: "int", required: true, min: 1, error: "invalid" },
  };
  if (!validAvatar(str(vars.agent_avatar), cfg.get("agent_avatar"))) errors.agent_avatar = "invalid";
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

/** OsticketConfig::updateUsersSettings */
export async function updateUsersSettings(executor: DbOrTx, cfg: ConfigWriter, vars: PhpVars, errors: Errors): Promise<boolean> {
  const f: Record<string, FieldRule> = {
    client_session_timeout: { type: "int", required: true, error: "required" },
  };
  if (!validAvatar(str(vars.client_avatar), cfg.get("client_avatar"))) errors.client_avatar = "invalid";
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
