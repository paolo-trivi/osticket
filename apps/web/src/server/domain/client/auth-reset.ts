import "server-only";

import { UserAccountStatus } from "@/lib/osticket/flags";

import type { ConfigNamespace } from "../../config/config";
import { db, type DbOrTx } from "../../db";
import { detectDbTimezone } from "../../db/time";
import { type ClientAuthOutcome, denied, lockedOut, loginWrites, prepare } from "./auth";
import { lookupAccountByUsername } from "./identity";

/**
 * Token di reset della password dei clienti (ClientPasswordResetTokenBackend): lettura e scadenza del
 * token (config namespace "pwreset"), login con il token e verifica per il cambio password.
 */

/** Config('pwreset')->get($token) con data di ultima modifica */
export async function resetToken(executor: DbOrTx, token: string) {
  if (!token) return null;
  return (await executor.selectFrom("config").select(["value", "updated"]).where("namespace", "=", "pwreset").where("key", "=", token).executeTakeFirst()) ?? null;
}

/** Token più vecchio di pw_reset_window minuti? */
async function tokenExpired(executor: DbOrTx, cfg: ConfigNamespace, updated: string): Promise<boolean> {
  const zone = await detectDbTimezone(executor);
  const { DateTime } = await import("luxon");
  const ts = DateTime.fromSQL(updated, { zone });
  if (!ts.isValid) return true;
  return cfg.int("pw_reset_window") * 60 < Date.now() / 1000 - ts.toSeconds();
}

/**
 * pwreset.php POST do=reset → ClientPasswordResetTokenBackend::signOn (token valido per l'utente e non
 * scaduto → stato "cambio password obbligatorio") e login. Gli errori di signOn non arrivano alla
 * pagina nel PHP ($errors passato per valore): l'esito è "Unknown user" con uno strike; qui il codice.
 */
export async function performResetTokenLogin(input: { userid: string; token: string; ip: string }): Promise<ClientAuthOutcome> {
  const cfg = await prepare();
  const { ip } = input;
  if (lockedOut(cfg, ip)) return denied(cfg, "", ip, "locked_out");
  const userid = input.userid.trim();
  const out = await db()
    .transaction()
    .execute(async (tx): Promise<ClientAuthOutcome> => {
      const acct = await lookupAccountByUsername(tx, userid);
      if (!acct) return { ok: false, error: "invalid_user" };
      const t = await resetToken(tx, input.token);
      if (!t || t.value !== `c${acct.user_id}`) return { ok: false, error: "invalid_token" };
      if (await tokenExpired(tx, cfg, t.updated)) return { ok: false, error: "invalid_token" };
      // UserAccount::forcePasswdReset
      const status = acct.status | UserAccountStatus.REQUIRE_PASSWD_RESET;
      if (status !== acct.status) await tx.updateTable("user_account").set({ status }).where("id", "=", acct.id).execute();
      const r = await loginWrites(tx, cfg, acct.user_id, { ip, interactive: false });
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, userId: acct.user_id, pwv: r.pwv, guest: null, resetToken: input.token };
    });
  if (!out.ok) return denied(cfg, "", ip, out.error);
  return out;
}

/** Validità di un token di reset per l'utente (ClientAccount::update con reset-token in sessione). */
export async function resetTokenValid(executor: DbOrTx, cfg: ConfigNamespace, token: string, userId: number): Promise<boolean> {
  const t = await resetToken(executor, token);
  if (!t || t.value !== `c${userId}`) return false;
  return !(await tokenExpired(executor, cfg, t.updated));
}
