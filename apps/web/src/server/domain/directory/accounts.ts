import "server-only";

import { NOW } from "../../db";
import { hashPassword } from "../../auth/passwd";
import { randCode } from "../../mail/message-id";
import { sanitizeText } from "../../format/text";
import { GlobalPerm } from "../staff/staff";
import type { WriteContext } from "../ticket/context";
import { phpLooseEquals } from "../ticket/record";
import { baseUrl, defaultEmail, loadContentPage, sendContentMail, userTemplateVar } from "./content-mail";
import { isEmail } from "../forms/validator";
import { deleteUser, loadUserCore, setUserOrganization, type DirError, type DirResult } from "./users";

/**
 * Account dei clienti (UserAccount in include/class.user.php; ajax.users.php register/manage,
 * scp/users.php confirmlink/pwreset/mass_process). Stato: bit di UserAccountStatus.
 */
const AccountStatus = {
  CONFIRMED: 0x0001,
  LOCKED: 0x0002,
  REQUIRE_PASSWD_RESET: 0x0004,
  FORBID_PASSWD_RESET: 0x0008,
} as const;

/** Alfabeto predefinito di Misc::randCode */
export const MISC_RAND_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ01234567890_=";

interface AccountRow {
  id: number;
  user_id: number;
  status: number;
  timezone: string | null;
  lang: string | null;
  username: string | null;
  passwd: string | null;
  backend: string | null;
  extra: string | null;
}

async function loadAccount(ctx: WriteContext, userId: number): Promise<AccountRow | null> {
  const row = await ctx.tx
    .selectFrom("user_account")
    .select(["id", "user_id", "status", "timezone", "lang", "username", "passwd", "backend", "extra"])
    .where("user_id", "=", userId)
    .forUpdate()
    .executeTakeFirst();
  return row ?? null;
}

export type PasswordError = "too_short" | "too_long" | "same_as_current";

/**
 * osTicketPasswordPolicy::onSet (unica politica registrata): da 6 a 128 caratteri (strlen: byte),
 * diversa dalla password attuale ignorando le maiuscole.
 */
export function checkPasswordPolicy(passwd: string, current: string | null | undefined): PasswordError | null {
  const len = Buffer.byteLength(passwd, "utf8");
  if (len < 6) return "too_short";
  if (len > 128) return "too_long";
  if (passwd.toLowerCase() === String(current ?? "").toLowerCase()) return "same_as_current";
  return null;
}

/** Variabili del form account (ajax.users.php register/manage). */
export interface AccountVars {
  username?: string;
  timezone?: string;
  backend?: string;
  passwd1?: string;
  passwd2?: string;
  sendemail?: boolean;
  "pwreset-flag"?: boolean;
  "locked-flag"?: boolean;
  "forbid-pwchange-flag"?: boolean;
  "forbid-pwreset-flag"?: boolean;
}

/** UserAccount::sendUnlockEmail($template): token in config "pwreset", pagina di contenuto via email predefinita. */
async function sendUnlockEmail(ctx: WriteContext, userId: number, template: "pwreset-client" | "registration-client"): Promise<boolean> {
  const { tx, cfg } = ctx;
  const token = randCode(48, MISC_RAND_CHARS);
  const email = await defaultEmail(tx, cfg);
  const page = await loadContentPage(tx, template);
  if (!email || !page) return false;
  const user = await userTemplateVar(tx, userId, cfg);
  if (!user) return false;
  const link = `${baseUrl(cfg)}/pwreset.php?token=${token}`;
  const vars = { token, user: user.v, recipient: user.v, link, reset_link: link };
  // Config('pwreset')->set($token, 'c'.$user_id)
  await tx.insertInto("config").values({ namespace: "pwreset", key: token, value: `c${userId}`, updated: NOW }).execute();
  ctx.after.push(await sendContentMail(tx, cfg, { email, page, vars, to: { name: user.name, address: user.email } }));
  return true;
}

/** UserAccount::sendResetEmail (scp/users.php do=pwreset) */
export async function sendUserResetEmail(ctx: WriteContext, userId: number): Promise<DirResult> {
  if (!(await loadAccount(ctx, userId))) return { ok: false, error: "no_account" };
  return (await sendUnlockEmail(ctx, userId, "pwreset-client")) ? { ok: true } : { ok: false, error: "send_failed" };
}

/** UserAccount::sendConfirmEmail (scp/users.php do=confirmlink: rifiutata se l'account è già confermato) */
export async function sendUserConfirmEmail(ctx: WriteContext, userId: number, checkConfirmed = true): Promise<DirResult> {
  const acct = await loadAccount(ctx, userId);
  if (!acct) return { ok: false, error: "no_account" };
  if (checkConfirmed && acct.status & AccountStatus.CONFIRMED) return { ok: false, error: "already_confirmed" };
  return (await sendUnlockEmail(ctx, userId, "registration-client")) ? { ok: true } : { ok: false, error: "send_failed" };
}

/** UserAccount::register($user, $vars) (ajax.users.php:register; con sendemail anche l'azione di massa) */
export async function registerAccount(ctx: WriteContext, userId: number, vars: AccountVars, checkPerm = true): Promise<DirResult> {
  const { tx, agent } = ctx;
  if (checkPerm && (!agent || !agent.hasGlobalPerm(GlobalPerm.USER_MANAGE))) return { ok: false, error: "forbidden" };
  const user = await loadUserCore(tx, userId);
  if (!user) return { ok: false, error: "not_found" };
  if (await loadAccount(ctx, userId)) return { ok: false, error: "already_registered" };
  const fields: Record<string, string> = {};
  if ((!vars.backend || vars.backend !== "client") && vars.sendemail === undefined) {
    if (!vars.passwd1) fields.passwd1 = "required";
    else if (vars.passwd1 !== (vars.passwd2 ?? "")) fields.passwd2 = "mismatch";
    else {
      const e = checkPasswordPolicy(vars.passwd1, null);
      if (e) fields.passwd1 = e;
    }
  }
  if (Object.keys(fields).length) return { ok: false, error: "invalid", fields };

  let status = 0;
  const values: Record<string, unknown> = { user_id: userId, timezone: vars.timezone || null, backend: vars.backend || null };
  // strcasecmp($vars['username'], $user->getEmail()): getEmail() è '"Nome" <indirizzo>', quindi il
  // nome utente viene impostato anche se coincide con l'indirizzo (stranezza del PHP replicata)
  if (vars.username) {
    const cur = await tx.selectFrom("user_email").select("address").where("id", "=", user.default_email_id).executeTakeFirst();
    const full = `"${user.name.replace(/"/g, '\\"')}" <${cur?.address ?? ""}>`;
    if (vars.username.toLowerCase() !== full.toLowerCase()) values.username = sanitizeText(vars.username);
  }
  if (vars.passwd1 && !vars.sendemail) {
    values.passwd = hashPassword(vars.passwd1);
    status |= AccountStatus.CONFIRMED;
    if (vars["pwreset-flag"]) status |= AccountStatus.REQUIRE_PASSWD_RESET;
    if (vars["forbid-pwreset-flag"]) status |= AccountStatus.FORBID_PASSWD_RESET;
  } else if (vars.backend && vars.backend !== "client") {
    status |= AccountStatus.CONFIRMED;
  }
  if (status) values.status = status;
  await tx.insertInto("user_account").values(values as never).execute();
  if (!(status & AccountStatus.CONFIRMED) && vars.sendemail) await sendUnlockEmail(ctx, userId, "registration-client");
  return { ok: true };
}

/** UserAccount::update($vars) (ajax.users.php:manage, scp/users.php do=update) */
export async function updateAccount(ctx: WriteContext, userId: number, vars: AccountVars, checkPerm = true): Promise<DirResult> {
  const { tx, agent } = ctx;
  if (checkPerm && (!agent || !agent.hasGlobalPerm(GlobalPerm.USER_MANAGE))) return { ok: false, error: "forbidden" };
  const acct = await loadAccount(ctx, userId);
  if (!acct) return { ok: false, error: "no_account" };
  const fields: Record<string, string> = {};
  // Nota: il PHP non verifica che passwd2 coincida con passwd1 (stranezza replicata)
  if (vars.passwd1 || vars.passwd2) {
    if (!vars.passwd1) fields.passwd1 = "required";
    else {
      const e = checkPasswordPolicy(vars.passwd1, null);
      if (e) fields.passwd1 = e;
    }
  }
  if (vars.username && isEmail(vars.username)) fields.username = "is_email";
  if (Object.keys(fields).length) return { ok: false, error: "invalid", fields };

  const set: Record<string, unknown> = {};
  const assign = (k: keyof AccountRow, v: unknown) => {
    const cur = k in set ? set[k] : acct[k];
    if (!phpLooseEquals(cur, v)) set[k] = v;
  };
  assign("timezone", vars.timezone ?? null);
  assign("username", sanitizeText(vars.username ?? ""));
  let status = acct.status;
  if (vars.passwd1) {
    set.passwd = hashPassword(vars.passwd1);
    status |= AccountStatus.CONFIRMED;
  }
  const flags: [keyof AccountVars, number][] = [
    ["pwreset-flag", AccountStatus.REQUIRE_PASSWD_RESET],
    ["locked-flag", AccountStatus.LOCKED],
    ["forbid-pwchange-flag", AccountStatus.FORBID_PASSWD_RESET],
  ];
  for (const [k, flag] of flags) status = vars[k] ? status | flag : status & ~flag;
  assign("status", status);
  if (Object.keys(set).length) await tx.updateTable("user_account").set(set as never).where("id", "=", acct.id).execute();
  return { ok: true };
}

/** UserAccount::lock()/unlock() */
async function setLocked(ctx: WriteContext, userId: number, locked: boolean): Promise<boolean> {
  const acct = await loadAccount(ctx, userId);
  if (!acct) return false;
  const status = locked ? acct.status | AccountStatus.LOCKED : acct.status & ~AccountStatus.LOCKED;
  if (status !== acct.status) await ctx.tx.updateTable("user_account").set({ status }).where("id", "=", acct.id).execute();
  return true;
}

export type UserMassAction =
  | { action: "lock" | "unlock" | "reset" | "register" }
  | { action: "delete"; deleteTickets?: boolean }
  | { action: "setorg"; orgId: number };

/**
 * scp/users.php do=mass_process. Permessi: il PHP non li controlla (bug di permessi, non replicato):
 * lock/unlock/reset/register richiedono user.manage, delete user.delete, setorg user.edit.
 */
export async function massUserAction(ctx: WriteContext, ids: number[], op: UserMassAction): Promise<{ ok: boolean; count: number; error?: DirError }> {
  const { agent, tx } = ctx;
  const perm =
    op.action === "delete" ? GlobalPerm.USER_DELETE : op.action === "setorg" ? GlobalPerm.USER_EDIT : GlobalPerm.USER_MANAGE;
  if (!agent || !agent.hasGlobalPerm(perm)) return { ok: false, count: 0, error: "forbidden" };
  const rows = ids.length ? await tx.selectFrom("user").select("id").where("id", "in", ids).orderBy("id").execute() : [];
  let count = 0;
  for (const { id } of rows) {
    switch (op.action) {
      case "lock":
      case "unlock":
        if (await setLocked(ctx, id, op.action === "lock")) count++;
        break;
      case "reset":
        if ((await loadAccount(ctx, id)) && (await sendUserResetEmail(ctx, id)).ok) count++;
        break;
      case "register":
        if (await loadAccount(ctx, id)) {
          if ((await sendUserConfirmEmail(ctx, id, false)).ok) count++;
        } else if ((await registerAccount(ctx, id, { sendemail: true }, false)).ok) count++;
        break;
      case "delete":
        if ((await deleteUser(ctx, id, { deleteTickets: op.deleteTickets, checkPerm: false })).ok) count++;
        break;
      case "setorg":
        if ((await setUserOrganization(ctx, id, op.orgId, false)).ok) count++;
        break;
    }
  }
  return { ok: count > 0, count };
}
