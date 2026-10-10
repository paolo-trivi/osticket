import { startClientSession } from "@/server/auth/client-auth";
import { clientIp } from "@/server/auth/session";
import { performTokenSignOn } from "@/server/domain/client/auth-access-link";
import { withBase } from "@/lib/base-path";
import { localRedirect } from "@/server/http/redirect";

/**
 * view.php?auth=<token> (o i vecchi link ?t=&e=&a=): accesso come ospite al ticket del link
 * (AuthTokenAuthentication) e rimando alla vista del ticket; altrimenti alla verifica dello stato.
 * È un route handler perché scrive il cookie di sessione.
 */
export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const ip = await clientIp();
  const res = await performTokenSignOn({
    auth: q.get("auth") ?? undefined,
    t: q.get("t") ?? undefined,
    e: q.get("e") ?? undefined,
    a: q.get("a") ?? undefined,
    ip,
  });
  if (res?.ok && res.guest) {
    await startClientSession(res);
    return localRedirect(withBase(`/tickets/${res.guest.ticketId}`));
  }
  const err = res && !res.ok ? `?error=${res.error}` : "?error=link";
  return localRedirect(withBase(`/login${err}#access`));
}
