import "server-only";

import { burnPasswordCheck, checkPassword } from "../../auth/passwd";
import { db } from "../../db";
import { type ClientAuthOutcome, denied, lockedOut, loginWrites, prepare } from "./auth";
import { isUserId, lookupAccountByUsername } from "./identity";
import { withWriteScope } from "../../system/write-mode";

/** Login dei clienti con nome utente (o email) e password (osTicketClientAuthentication). */

/**
 * login.php (POST luser/lpasswd) → UserAuthenticationBackend::process con osTicketClientAuthentication.
 * Account non confermato o bloccato: AccessDenied, contato come tentativo fallito (come il PHP).
 * Account con backend esterno (LDAP/OAuth): non gestiti dalla app.
 */
export async function performClientLogin(input: { login: string; password: string; ip: string }): Promise<ClientAuthOutcome> {
  return withWriteScope("operational", () => clientLogin(input), {
    op: "client.login",
  });
}

async function clientLogin(input: { login: string; password: string; ip: string }): Promise<ClientAuthOutcome> {
  const cfg = await prepare();
  const username = input.login.trim();
  const { ip } = input;
  if (!username) return { ok: false, error: "required" };
  if (!isUserId(username)) return { ok: false, error: "invalid_userid" };
  if (lockedOut(cfg, ip)) return denied(cfg, username, ip, "locked_out");

  const acct = await lookupAccountByUsername(db(), username);
  if (acct?.backend && acct.backend !== "client") return { ok: false, error: "backend" };
  if (!acct) burnPasswordCheck(input.password.slice(0, 128));
  const check = acct ? checkPassword(input.password.slice(0, 128), acct.passwd) : ({ ok: false } as const);
  if (!acct || !check.ok) return denied(cfg, username, ip, "invalid");

  const r = await db()
    .transaction()
    .execute((tx) => loginWrites(tx, cfg, acct.user_id, { ip, interactive: true, rehash: check.rehash }));
  if (!r.ok) return denied(cfg, username, ip, r.error);
  // Il login riuscito NON azzera il contatore dell'IP: come UserAuthStrikeBackend (azzerato solo allo
  // scadere del blocco), altrimenti un proprio account permetterebbe tentativi illimitati su quelli altrui
  return { ok: true, userId: acct.user_id, pwv: r.pwv, guest: null };
}
