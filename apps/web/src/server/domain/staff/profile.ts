import "server-only";

import { NOW, type DbOrTx } from "../../db";
import { checkPassword, hashPassword } from "../../auth/passwd";
import { stripTags } from "../../format/html";
import { sanitizeText } from "../../format/text";
import { checkPasswordPolicy, type PasswordError } from "../directory/accounts";
import { formatPhone } from "../forms/fields";
import { isPhone, isValidEmail } from "../forms/validator";
import type { WriteContext } from "../ticket/context";
import { loadAgent } from "./staff";
import { saveStaffChanges, updateStaffConfig } from "./staff-write";

/**
 * Profilo dell'agente: scp/profile.php → Staff::updateProfile e ajax.staff.php changePassword.
 * Il reset della password (scp/pwreset.php) è in password-reset.ts, il 2FA in two-factor.ts.
 */

interface ProfileVars {
  firstname: string;
  lastname: string;
  email: string;
  phone?: string;
  phone_ext?: string;
  mobile?: string;
  signature?: string;
  timezone?: string;
  locale?: string;
  max_page_size?: string | number;
  auto_refresh_rate?: string | number;
  default_signature_type?: string;
  default_paper_size?: string;
  lang?: string;
  onvacation?: boolean;
  datetime_format?: string;
  default_from_name?: string;
  default_2fa?: string;
  thread_view_order?: string;
  default_ticket_queue_id?: string | number;
  reply_redirect?: string;
  img_att_view?: string;
  editor_spacing?: string;
}

type ProfileResult = { ok: true } | { ok: false; error: "forbidden" | "invalid" | "not_found"; fields?: Record<string, string> };

/** Staff::updateProfile($vars) */
export async function updateStaffProfile(ctx: WriteContext, vars: ProfileVars): Promise<ProfileResult> {
  const { tx, cfg } = ctx;
  if (!ctx.agent) return { ok: false, error: "forbidden" };
  const agent = await loadAgent(ctx.agent.id, tx);
  if (!agent) return { ok: false, error: "not_found" };
  const firstname = stripTags(vars.firstname ?? "");
  const lastname = stripTags(vars.lastname ?? "");
  const fields: Record<string, string> = {};
  if (!firstname) fields.firstname = "required";
  if (!lastname) fields.lastname = "required";
  const email = vars.email ?? "";
  if (!email || !(await isValidEmail(email, cfg.bool("verify_email_addrs")))) fields.email = "invalid";
  else if (await tx.selectFrom("email").select("email_id").where("email", "=", email).executeTakeFirst()) fields.email = "system_email";
  else {
    const other = await tx.selectFrom("staff").select("staff_id").where("email", "=", email).executeTakeFirst();
    if (other && other.staff_id !== agent.id) fields.email = "in_use";
  }
  if (vars.phone && !isPhone(vars.phone)) fields.phone = "invalid";
  if (vars.mobile && !isPhone(vars.mobile)) fields.mobile = "invalid";
  if (vars.default_signature_type === "mine" && !vars.signature) fields.default_signature_type = "no_signature";
  if (Object.keys(fields).length) return { ok: false, error: "invalid", fields };

  await updateStaffConfig(tx, agent.id, {
    datetime_format: vars.datetime_format ?? "",
    default_from_name: vars.default_from_name ?? "",
    default_2fa: vars.default_2fa ?? "",
    thread_view_order: vars.thread_view_order ?? "",
    default_ticket_queue_id: String(vars.default_ticket_queue_id ?? ""),
    reply_redirect: vars.reply_redirect === "Queue" ? "Queue" : "Ticket",
    img_att_view: vars.img_att_view === "inline" ? "inline" : "download",
    editor_spacing: vars.editor_spacing === "double" ? "double" : "single",
  });
  await saveStaffChanges(tx, agent, {
    firstname,
    lastname,
    email,
    phone: formatPhone(vars.phone ?? ""),
    phone_ext: vars.phone_ext ?? "",
    mobile: formatPhone(vars.mobile ?? ""),
    signature: sanitizeText(vars.signature ?? ""),
    timezone: vars.timezone ?? "",
    locale: vars.locale ?? "",
    max_page_size: Number(vars.max_page_size) || 0,
    auto_refresh_rate: Number(vars.auto_refresh_rate) || 0,
    default_signature_type: vars.default_signature_type ?? "",
    default_paper_size: vars.default_paper_size ?? "",
    lang: vars.lang ?? "",
    onvacation: vars.onvacation ? 1 : 0,
  });
  return { ok: true };
}

/* ------------------------------------------------------------------ password */

type ChangePasswordResult =
  | { ok: true; passwdreset: string }
  | { ok: false; error: "forbidden" | "invalid" | "token"; fields?: Record<string, PasswordError | "required" | "incorrect" | "mismatch"> };

/** Staff::cancelResetTokens: token di reset dell'agente in config "pwreset". */
async function cancelResetTokens(executor: DbOrTx, staffId: number): Promise<void> {
  await executor.deleteFrom("config").where("namespace", "=", "pwreset").where("value", "=", String(staffId)).execute();
}

/**
 * ajax.staff.php:changePassword (PasswordChangeForm + Staff::setPassword): password attuale
 * (non richiesta durante il reset con token), conferma, politica; poi passwd, change_passwd = 0,
 * passwdreset = NOW, token di reset annullati. Restituisce il nuovo passwdreset per la sessione.
 */
export async function changeStaffPassword(
  ctx: WriteContext,
  input: { current?: string; passwd1: string; passwd2: string; resetToken?: string | null },
): Promise<ChangePasswordResult> {
  const { tx, cfg } = ctx;
  if (!ctx.agent) return { ok: false, error: "forbidden" };
  const agent = await loadAgent(ctx.agent.id, tx);
  if (!agent) return { ok: false, error: "forbidden" };
  const fields: Record<string, PasswordError | "required" | "incorrect" | "mismatch"> = {};
  const withToken = !!input.resetToken;
  if (!withToken) {
    if (!input.current) fields.current = "required";
    else if (!checkPassword(input.current, agent.row.passwd).ok) fields.current = "incorrect";
  }
  if (!input.passwd1) fields.passwd1 = "required";
  else {
    const e = checkPasswordPolicy(input.passwd1, null);
    if (e) fields.passwd1 = e;
  }
  if (!input.passwd2) fields.passwd2 = "required";
  if (!fields.passwd1 && input.passwd1 !== input.passwd2) fields.passwd1 = "mismatch";
  if (Object.keys(fields).length) return { ok: false, error: "invalid", fields };
  if (withToken) {
    const tok = await tx.selectFrom("config").select(["value", "updated"]).where("namespace", "=", "pwreset").where("key", "=", input.resetToken!).executeTakeFirst();
    // Il PHP controlla la finestra di validità con una condizione sempre falsa (&& invece di ||): replicato
    if (!tok || tok.value !== String(agent.id)) return { ok: false, error: "token" };
  }
  // Staff::setPassword → politiche onSet($new, $current)
  const pol = checkPasswordPolicy(input.passwd1, withToken ? null : input.current);
  if (pol) return { ok: false, error: "invalid", fields: { passwd1: pol } };
  await cancelResetTokens(tx, agent.id);
  await saveStaffChanges(tx, agent, { passwd: hashPassword(input.passwd1), change_passwd: 0, passwdreset: NOW });
  const fresh = await tx.selectFrom("staff").select("passwdreset").where("staff_id", "=", agent.id).executeTakeFirstOrThrow();
  void cfg;
  return { ok: true, passwdreset: String(fresh.passwdreset ?? "") };
}
