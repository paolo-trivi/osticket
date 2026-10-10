import { startClientSession } from "@/server/auth/client-auth";
import { clientIp } from "@/server/auth/session";
import { performConfirm } from "@/server/domain/client/auth-confirm";
import { withBase } from "@/lib/base-path";
import { localRedirect } from "@/server/http/redirect";

/**
 * pwreset.php?token=<token> per un account non confermato: conferma, apertura della sessione e
 * rimando al profilo (account.php?confirmed, oppure cambio password obbligatorio se l'account non
 * ha ancora una password). Account già confermato: form del reset con il token.
 */
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const res = await performConfirm({ token, ip: await clientIp() });
  if (res.ok && res.confirmed) {
    await startClientSession(res);
    return localRedirect(withBase(res.forceReset ? "/profile?pwchange=1" : "/profile?confirmed=1"));
  }
  if (res.ok) return localRedirect(withBase(`/pwreset?token=${encodeURIComponent(token)}&form=1`));
  return localRedirect(withBase(res.error === "not_found" ? "/" : `/login?error=${res.error}`));
}
