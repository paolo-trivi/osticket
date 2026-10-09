import "server-only";

import { NOW, type DbOrTx } from "../../db";
import { checkPassword, hashPassword } from "../../auth/passwd";
import { EMAIL_2FA, prepare2faEmail, staff2faConfig, validateOtp, type OtpCheck } from "../../auth/mfa";
import type { ConfigNamespace } from "../../config/config";
import { stripTags } from "../../format/html";
import { phpJsonEncode } from "../../format/php-json";
import { sanitizeText } from "../../format/text";
import { randCode } from "../../mail/message-id";
import { loadStaffInfo, staffVar } from "../../mail/objects";
import { logSystem } from "../../system/syslog";
import { MISC_RAND_CHARS, checkPasswordPolicy, type PasswordError } from "../directory/accounts";
import { alertOrDefaultEmail, baseUrl, loadContentPage, sendContentMail } from "../directory/content-mail";
import { formatPhone } from "../forms/fields";
import { isPhone, isValidEmail } from "../forms/validator";
import type { WriteContext } from "../ticket/context";
import { phpLooseEquals } from "../ticket/record";
import { loadAgent, type Agent } from "./staff";

/**
 * Profilo dell'agente (scp/profile.php → Staff::updateProfile, ajax.staff.php changePassword e
 * configure2FA, scp/pwreset.php → Staff::sendResetEmail e PasswordResetTokenBackend).
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

/** Config::updateAll sul namespace "staff.<id>": INSERT delle chiavi nuove, UPDATE di quelle cambiate. */
async function updateStaffConfig(executor: DbOrTx, staffId: number, values: Record<string, string>): Promise<void> {
  const ns = `staff.${staffId}`;
  const rows = await executor.selectFrom("config").select(["id", "key", "value"]).where("namespace", "=", ns).execute();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  for (const [key, value] of Object.entries(values)) {
    const row = byKey.get(key);
    if (!row) await executor.insertInto("config").values({ namespace: ns, key, value, updated: NOW }).execute();
    else if (!phpLooseEquals(row.value, value)) await executor.updateTable("config").set({ value, updated: NOW }).where("id", "=", row.id).execute();
  }
}

/** Salvataggio di Staff (Staff::save): solo colonne cambiate (confronto debole), updated = NOW se sporco. */
async function saveStaff(executor: DbOrTx, agent: Agent, values: Record<string, unknown>): Promise<void> {
  const set: Record<string, unknown> = {};
  const row = agent.row as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(values)) {
    if (v === NOW || !phpLooseEquals(row[k], v)) set[k] = v;
  }
  if (!Object.keys(set).length) return;
  set.updated = NOW;
  await executor.updateTable("staff").set(set as never).where("staff_id", "=", agent.id).execute();
}

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
  await saveStaff(tx, agent, {
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
  await saveStaff(tx, agent, { passwd: hashPassword(input.passwd1), change_passwd: 0, passwdreset: NOW });
  const fresh = await tx.selectFrom("staff").select("passwdreset").where("staff_id", "=", agent.id).executeTakeFirstOrThrow();
  void cfg;
  return { ok: true, passwdreset: String(fresh.passwdreset ?? "") };
}

/* ------------------------------------------------------------------ reset via email */

/** Staff::lookup($userid): id numerico, email o username. */
async function lookupStaffId(executor: DbOrTx, userid: string): Promise<number | null> {
  const v = userid;
  let q = executor.selectFrom("staff").select("staff_id");
  if (/^\s*\d+\s*$/.test(v)) q = q.where("staff_id", "=", Number(v));
  else if (v.includes("@")) q = q.where("email", "=", v);
  else if (v.length >= 2 && /^[\p{L}\d._-]+$/u.test(v)) q = q.where("username", "=", v);
  else return null;
  return (await q.executeTakeFirst())?.staff_id ?? null;
}

/** Validator::is_userid (senza verifica DNS) */
function isUserid(v: string): boolean {
  const username = v.length >= 2 && !/^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/.test(v) && /^[\p{L}\d._-]+$/u.test(v);
  return username || /^[^\s@<>(),;:"[\]]+@[^\s@<>(),;:"[\]]+$/.test(v.trim());
}

/**
 * scp/pwreset.php do=sendmail → Staff::sendResetEmail('pwreset-staff'): syslog "Agent Password Reset"
 * (Warning senza avviso), token in config "pwreset" (valore = staff_id), email dall'email di avviso.
 * Con utente sconosciuto, senza password o con backend esterno non si scrive nulla.
 */
export async function sendStaffResetEmail(
  executor: DbOrTx,
  cfg: ConfigNamespace,
  userid: string,
  ip: string,
): Promise<{ sent: boolean; send?: () => Promise<void>; error?: "unavailable" }> {
  if (!cfg.bool("allow_pw_reset")) return { sent: false, error: "unavailable" };
  if (!isUserid(userid)) return { sent: false };
  const staffId = await lookupStaffId(executor, userid);
  if (!staffId) return { sent: false };
  const s = await executor.selectFrom("staff").select(["staff_id", "passwd", "backend", "email", "lang", "extra"]).where("staff_id", "=", staffId).executeTakeFirst();
  if (!s) return { sent: false };
  if (!s.passwd || (s.backend && !["local", ""].includes(s.backend.toLowerCase()))) return { sent: false, error: "unavailable" };
  const page = await loadContentPage(executor, "pwreset-staff");
  if (!page) return { sent: false };
  const token = randCode(48, MISC_RAND_CHARS);
  const email = await alertOrDefaultEmail(executor, cfg);
  const info = await loadStaffInfo(executor, staffId);
  if (!email || !info) return { sent: false };
  const v = staffVar(info, cfg);
  const link = `${baseUrl(cfg)}/scp/pwreset.php?token=${token}`;
  // osTicket::log: Format::sanitize($message, false) del testo del log
  await logSystem(
    "Warning",
    "Agent Password Reset",
    sanitizeText(`Password reset was attempted for agent: ${v.asVar(null as never)}<br><br>
                Requested-User-Id: ${userid}<br>
                Source-Ip: ${ip}<br>
                Email-Sent-To: ${s.email}<br>
                Email-Sent-Via: ${email.email}`),
    ip,
    { executor },
  );
  await executor.insertInto("config").values({ namespace: "pwreset", key: token, value: String(staffId), updated: NOW }).execute();
  const send = await sendContentMail(executor, cfg, {
    email,
    page,
    vars: { token, staff: v, recipient: v, reset_link: link, link },
    to: { name: "", address: s.email ?? "" },
  });
  return { sent: true, send };
}

/** Token di reset valido per un agente (scp/pwreset.php ?token=): restituisce lo staff_id. */
export async function staffIdForResetToken(executor: DbOrTx, token: string): Promise<number | null> {
  if (!token) return null;
  const row = await executor.selectFrom("config").select("value").where("namespace", "=", "pwreset").where("key", "=", token).executeTakeFirst();
  if (!row || !/^\d+$/.test(row.value)) return null;
  return Number(row.value);
}

/**
 * PasswordResetTokenBackend::signOn: utente e token coincidenti, token entro pw_reset_window,
 * poi forcePasswdRest (change_passwd = 1, updated). Il login che segue non annulla il token
 * (supportsInteractiveAuthentication = false): lo annulla il cambio password.
 */
export async function verifyStaffResetToken(
  executor: DbOrTx,
  cfg: ConfigNamespace,
  userid: string,
  token: string,
): Promise<{ ok: true; staffId: number } | { ok: false; error: "invalid_user" | "invalid_token" }> {
  const staffId = await lookupStaffId(executor, userid);
  if (!staffId) return { ok: false, error: "invalid_user" };
  const row = await executor.selectFrom("config").select(["value", "updated"]).where("namespace", "=", "pwreset").where("key", "=", token).executeTakeFirst();
  if (!row || row.value !== String(staffId)) return { ok: false, error: "invalid_token" };
  const { rows } = await (await import("kysely")).sql<{ age: number }>`SELECT TIMESTAMPDIFF(SECOND, ${row.updated}, NOW()) AS age`.execute(executor);
  if (!row.updated || cfg.int("pw_reset_window") * 60 < Number(rows[0]?.age ?? 0)) return { ok: false, error: "invalid_token" };
  const agent = await loadAgent(staffId, executor);
  if (!agent) return { ok: false, error: "invalid_user" };
  await saveStaff(executor, agent, { change_passwd: 1 });
  return { ok: true, staffId };
}

/* ------------------------------------------------------------------ 2FA */

/**
 * ajax.staff.php:configure2FA stato "validate": salva {config:{email}, verified:0} (se non esterno)
 * e invia il codice. Restituisce la funzione di invio da eseguire dopo il commit.
 */
export async function setup2faEmail(ctx: WriteContext, address: string, key: string): Promise<{ ok: true; send: () => Promise<void> } | { ok: false; error: "invalid" | "send_failed" | "forbidden" }> {
  const { tx, cfg } = ctx;
  if (!ctx.agent) return { ok: false, error: "forbidden" };
  if (!address || !(await isValidEmail(address, cfg.bool("verify_email_addrs")))) return { ok: false, error: "invalid" };
  const current = staff2faConfig(ctx.agent.config);
  if (!current.config?.external2fa) {
    await updateStaffConfig(tx, ctx.agent.id, { [EMAIL_2FA]: phpJsonEncode({ config: { email: address }, verified: 0 }) });
  }
  const agent = await loadAgent(ctx.agent.id, tx);
  if (!agent) return { ok: false, error: "forbidden" };
  const send = await prepare2faEmail(tx, cfg, agent, key);
  if (!send) return { ok: false, error: "send_failed" };
  return { ok: true, send };
}

/** configure2FA stato "verify": codice valido → verified = time(). */
export async function verify2faSetup(ctx: WriteContext, key: string, otp: string, now = Math.floor(Date.now() / 1000)): Promise<OtpCheck> {
  if (!ctx.agent) return "missing";
  const r = validateOtp(key, ctx.agent.id, otp);
  if (r !== "ok") return r;
  const agent = await loadAgent(ctx.agent.id, ctx.tx);
  const conf = agent ? staff2faConfig(agent.config) : {};
  if (agent && Object.keys(conf).length) {
    await updateStaffConfig(ctx.tx, agent.id, { [EMAIL_2FA]: phpJsonEncode({ ...conf, verified: now }) });
  }
  return "ok";
}

/** Valore predefinito del 2FA (impostato dal profilo: default_2fa). */
export async function setDefault2fa(ctx: WriteContext, value: string): Promise<void> {
  if (!ctx.agent) return;
  await updateStaffConfig(ctx.tx, ctx.agent.id, { default_2fa: value });
}
