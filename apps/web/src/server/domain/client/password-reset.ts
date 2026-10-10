import "server-only";

import { UserAccountStatus } from "@/lib/osticket/flags";

import { coreConfig } from "../../config/config";
import { db } from "../../db";
import { detectDbTimezone } from "../../db/time";
import { isUserId, lookupAccountByUsername } from "./identity";
import { prepareUnlockMail } from "./mails";

/** Richiesta di reset della password dal portale (pwreset.php do=sendmail → UserAccount::sendResetEmail). */

type ResetRequestResult = { ok: true } | { ok: false; error: "disabled" | "unavailable" | "failed" };

/**
 * pwreset.php POST do=sendmail: nessuna informazione sull'esistenza dell'account (stessa risposta),
 * tempo minimo di risposta di 1,4 s più un ritardo casuale, come il PHP.
 */
export async function requestClientPasswordReset(userid: string, opts: { pad?: boolean } = {}): Promise<ResetRequestResult> {
  const start = Date.now();
  const cfg = await coreConfig();
  await detectDbTimezone(db());
  let out: ResetRequestResult = { ok: true };
  let send: (() => Promise<void>) | null = null;
  const id = userid.trim();
  if (isUserId(id)) {
    await db()
      .transaction()
      .execute(async (tx) => {
        const acct = await lookupAccountByUsername(tx, id);
        if (!acct) return;
        if (acct.status & UserAccountStatus.FORBID_PASSWD_RESET) out = { ok: false, error: "disabled" };
        else if (!acct.passwd || (acct.backend && acct.backend !== "client")) out = { ok: false, error: "unavailable" };
        else {
          send = await prepareUnlockMail(tx, cfg, acct.user_id, "pwreset-client");
          if (!send) out = { ok: false, error: "failed" };
        }
      });
  }
  if (send) {
    try {
      await (send as () => Promise<void>)();
    } catch (err) {
      console.error("[portal] email di reset non inviata", err);
    }
  }
  if (opts.pad !== false) {
    const target = 1400 + Math.floor(Math.random() * 251);
    const elapsed = Date.now() - start;
    if (elapsed < target) await new Promise((r) => setTimeout(r, target - elapsed));
  }
  return out;
}
