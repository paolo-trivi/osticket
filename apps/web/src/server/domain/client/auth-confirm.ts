import "server-only";

import { UserAccountStatus } from "@/lib/osticket/flags";

import { db } from "../../db";
import { type ClientAuthError, type ClientLogin, lockedOut, loginWrites, prepare, strike } from "./auth";
import { resetToken } from "./auth-reset";
import { accountIsConfirmed, loadClientAccount, type ClientAccountRow } from "./identity";
import { canWrite, withWriteScope } from "../../system/write-mode";

/** Conferma dell'account del cliente dal link dell'email di registrazione (ClientAcctConfirmationTokenBackend). */

type ConfirmOutcome = ({ ok: true; confirmed: true; forceReset: boolean } & ClientLogin) | { ok: true; confirmed: false; form: true } | { ok: false; error: ClientAuthError | "not_found" };

/**
 * pwreset.php?token=<token> (GET): se l'account non è confermato lo conferma e apre la sessione
 * (ClientAcctConfirmationTokenBackend); con password locale annulla i token, altrimenti obbliga a
 * impostarla. Se l'account è già confermato il token serve al reset: si mostra il form username.
 */
export async function performConfirm(input: { token: string; ip: string }): Promise<ConfirmOutcome> {
  return withWriteScope("operational", () => confirm(input), {
    op: "client.confirm",
  });
}

async function confirm(input: { token: string; ip: string }): Promise<ConfirmOutcome> {
  const cfg = await prepare();
  const { ip } = input;
  const out = await db()
    .transaction()
    .execute(async (tx): Promise<ConfirmOutcome | { ok: false; error: ClientAuthError; strike: true }> => {
      const t = await resetToken(tx, input.token);
      const acct: ClientAccountRow | null = t && /^c\d+$/.test(t.value ?? "") ? await loadClientAccount(tx, Number(t.value!.slice(1)), true) : null;
      if (!t || !acct) return { ok: false, error: "not_found" };
      if (accountIsConfirmed(acct)) return { ok: true, confirmed: false, form: true };
      // la conferma è una scrittura: in sola lettura l'account resta da confermare
      if (!(await canWrite("operational"))) return { ok: false, error: "read_only" };
      // UserAccount::confirm
      await tx.updateTable("user_account").set({ status: acct.status | UserAccountStatus.CONFIRMED }).where("id", "=", acct.id).execute();
      // processSignOn($errors): strike backend, poi ClientAcctConfirmationTokenBackend
      if (lockedOut(cfg, ip)) return { ok: false, error: "locked_out", strike: true };
      const r = await loginWrites(tx, cfg, acct.user_id, { ip, interactive: false });
      if (!r.ok) return { ok: false, error: r.error, strike: true };
      let forceReset = false;
      if (acct.passwd && !acct.backend) {
        await tx.deleteFrom("config").where("namespace", "=", "pwreset").where("value", "=", `c${acct.user_id}`).execute();
      } else {
        forceReset = true;
        const cur = await tx.selectFrom("user_account").select("status").where("id", "=", acct.id).executeTakeFirstOrThrow();
        if (!(cur.status & UserAccountStatus.REQUIRE_PASSWD_RESET)) await tx.updateTable("user_account").set({ status: cur.status | UserAccountStatus.REQUIRE_PASSWD_RESET }).where("id", "=", acct.id).execute();
      }
      return { ok: true, confirmed: true, forceReset, userId: acct.user_id, pwv: r.pwv, guest: null, ...(forceReset ? { resetToken: input.token } : {}) };
    });
  if (!out.ok && "strike" in out) {
    await strike(cfg, "", ip);
    return { ok: false, error: out.error };
  }
  return out as ConfirmOutcome;
}
