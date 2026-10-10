import "server-only";

import { hashPassword } from "../../auth/passwd";
import type { ConfigNamespace } from "../../config/config";
import { loadConfigNamespace } from "../../config/config";
import { NOW, type DbOrTx } from "../../db";
import { sanitizeText } from "../../format/text";
import { randCode } from "../../mail/message-id";
import { loadStaffInfo, staffVar } from "../../mail/objects";
import { str, type PhpVal } from "../../php/values";
import { logSystem } from "../../system/syslog";
import { MISC_RAND_CHARS, checkPasswordPolicy } from "../directory/accounts";
import { alertOrDefaultEmail, baseUrl, loadContentPage, sendContentMail } from "../directory/content-mail";
import { OrmRow, SQL_NOW } from "./orm";
import { loadStaffRow } from "./staff-row";

/**
 * Password degli agenti dall'amministrazione: Staff::setPassword, Staff::sendResetEmail (benvenuto e
 * reset) e ajax.staff.php:setPassword (reset via email o password impostata dall'amministratore).
 */

/** Staff::setPassword($new, null) con osTicketStaffAuthentication: hash, change_passwd 0, token annullati. */
export async function setPassword(executor: DbOrTx, row: OrmRow, passwd: string): Promise<void> {
  row.set("passwd", hashPassword(passwd));
  row.set("change_passwd", 0);
  // cancelResetTokens(): eseguito subito (anche prima del salvataggio dell'agente)
  if (row.get("staff_id")) await executor.deleteFrom("config").where("namespace", "=", "pwreset").where("value", "=", str(row.get("staff_id") as PhpVal)).execute();
  row.set("passwdreset", SQL_NOW);
}

/**
 * Staff::sendResetEmail($template, $log): pagina di contenuto (registration-staff per il benvenuto,
 * pwreset-staff per il reset), token in config "pwreset", syslog "Agent Password Reset" se $log.
 * Restituisce l'invio da eseguire dopo il commit.
 */
export async function sendAgentResetEmail(
  executor: DbOrTx,
  cfg: ConfigNamespace,
  staffId: number,
  template: "registration-staff" | "pwreset-staff",
  opts: { log: boolean; ip: string },
): Promise<(() => Promise<void>) | undefined> {
  const page = await loadContentPage(executor, template);
  if (!page) return undefined;
  const token = randCode(48, MISC_RAND_CHARS);
  const info = await loadStaffInfo(executor, staffId);
  const email = await alertOrDefaultEmail(executor, cfg);
  if (!info || !email) return undefined;
  const v = staffVar(info, cfg);
  const link = `${baseUrl(cfg)}/scp/pwreset.php?token=${token}`;
  if (opts.log)
    // $_POST['userid'] non esiste nelle richieste dell'admin: Requested-User-Id vuoto
    await logSystem(
      "Warning",
      "Agent Password Reset",
      sanitizeText(`Password reset was attempted for agent: ${v.asVar(null as never)}<br><br>
                Requested-User-Id: <br>
                Source-Ip: ${opts.ip}<br>
                Email-Sent-To: ${info.email ?? ""}<br>
                Email-Sent-Via: ${email.email}`),
      opts.ip,
      { executor },
    );
  await executor.insertInto("config").values({ namespace: "pwreset", key: token, value: String(staffId), updated: NOW }).execute();
  return sendContentMail(executor, cfg, {
    email,
    page,
    vars: { token, staff: v, recipient: v, reset_link: link, link },
    to: { name: "", address: info.email ?? "" },
  });
}

/**
 * ajax.staff.php:setPassword per un agente esistente (PasswordResetForm): email di reset
 * (Staff::sendResetEmail con syslog) oppure nuova password con eventuale cambio obbligatorio.
 */
export async function setAgentPassword(
  executor: DbOrTx,
  staffId: number,
  vars: { welcome_email?: boolean; passwd1?: string; passwd2?: string; change_passwd?: boolean },
  ip: string,
): Promise<{ ok: boolean; errors: Record<string, string>; send?: () => Promise<void> }> {
  const staff = await loadStaffRow(executor, staffId);
  if (!staff) return { ok: false, errors: { err: "not_found" } };
  const errors: Record<string, string> = {};
  if (!vars.welcome_email) {
    if (!vars.passwd1) errors.passwd1 = "required";
    else {
      const pe = checkPasswordPolicy(vars.passwd1, null);
      if (pe) errors.passwd1 = pe;
    }
    if (!vars.passwd2) errors.passwd2 = "required";
    else if (!errors.passwd1 && vars.passwd1 !== vars.passwd2) errors.passwd1 = "mismatch";
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  const cfg = await loadConfigNamespace("core", executor);
  let send: (() => Promise<void>) | undefined;
  if (vars.welcome_email) {
    send = await sendAgentResetEmail(executor, cfg, staffId, "pwreset-staff", { log: true, ip });
  } else {
    await setPassword(executor, staff, vars.passwd1!);
    if (vars.change_passwd) staff.set("change_passwd", 1);
  }
  await staff.save(executor);
  return { ok: true, errors: {}, send };
}
