import "server-only";

import { NOW, type DbOrTx } from "../../db";
import type { ConfigNamespace } from "../../config/config";
import { sanitizeText } from "../../format/text";
import { randCode } from "../../mail/message-id";
import { loadStaffInfo, staffVar } from "../../mail/objects";
import { logSystem } from "../../system/syslog";
import { MISC_RAND_CHARS } from "../directory/accounts";
import { alertOrDefaultEmail, baseUrl, loadContentPage, sendContentMail } from "../directory/content-mail";
import { loadAgent } from "./staff";
import { saveStaffChanges } from "./staff-write";

/** Reset della password dell'agente: scp/pwreset.php → Staff::sendResetEmail e PasswordResetTokenBackend. */

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
  await saveStaffChanges(executor, agent, { change_passwd: 1 });
  return { ok: true, staffId };
}
