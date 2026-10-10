import "server-only";

import { checkPassword } from "../../auth/passwd";
import { resetStrikes } from "../../auth/strikes";
import { db } from "../../db";
import { type ClientAuthOutcome, denied, lockedOut, loginWrites, prepare, REALM } from "./auth";
import { isUserId, lookupAccountByUsername } from "./identity";

/** Login dei clienti con nome utente (o email) e password (osTicketClientAuthentication). */

/**
 * login.php (POST luser/lpasswd) → UserAuthenticationBackend::process con osTicketClientAuthentication.
 * Account non confermato o bloccato: AccessDenied, contato come tentativo fallito (come il PHP).
 * Account con backend esterno (LDAP/OAuth): non gestiti dalla app.
 */
export async function performClientLogin(input: { login: string; password: string; ip: string }): Promise<ClientAuthOutcome> {
  const cfg = await prepare();
  const username = input.login.trim();
  const { ip } = input;
  if (!username) return { ok: false, error: "required" };
  if (!isUserId(username)) return { ok: false, error: "invalid_userid" };
  if (lockedOut(cfg, ip)) return denied(cfg, username, ip, "locked_out");

  const acct = await lookupAccountByUsername(db(), username);
  if (acct?.backend && acct.backend !== "client") return { ok: false, error: "backend" };
  const check = acct ? checkPassword(input.password.slice(0, 128), acct.passwd) : ({ ok: false } as const);
  if (!acct || !check.ok) return denied(cfg, username, ip, "invalid");

  const r = await db()
    .transaction()
    .execute((tx) => loginWrites(tx, cfg, acct.user_id, { ip, interactive: true, rehash: check.rehash }));
  if (!r.ok) return denied(cfg, username, ip, r.error);
  resetStrikes(REALM, ip, "");
  return { ok: true, userId: acct.user_id, pwv: r.pwv, guest: null };
}
