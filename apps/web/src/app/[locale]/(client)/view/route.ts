import { NextResponse } from "next/server";

import { startClientSession } from "@/server/auth/client-auth";
import { clientIp } from "@/server/auth/session";
import { performTokenSignOn } from "@/server/domain/client/auth-access-link";
import { withBase } from "@/lib/base-path";

/**
 * view.php?auth=<token> (o i vecchi link ?t=&e=&a=): accesso come ospite al ticket del link
 * (AuthTokenAuthentication) e rimando alla vista del ticket; altrimenti alla verifica dello stato.
 * È un route handler perché scrive il cookie di sessione.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const q = url.searchParams;
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
    return NextResponse.redirect(new URL(withBase(`/tickets/${res.guest.ticketId}`), url));
  }
  const err = res && !res.ok ? `?error=${res.error}` : "?error=link";
  return NextResponse.redirect(new URL(withBase(`/login${err}#access`), url));
}
