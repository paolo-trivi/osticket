import "server-only";

import { NextResponse } from "next/server";

/**
 * Redirect di un route handler verso un percorso della app, con Location relativa (RFC 9110 §10.2.2).
 * NextResponse.redirect vuole un URL assoluto, e new URL(path, request.url) dietro il reverse proxy
 * prende l'host interno del container (http://0.0.0.0:3000): la Location relativa invece il browser la
 * risolve sull'URL pubblico che ha richiesto. I cookie impostati con cookies() restano nella risposta.
 */
export function localRedirect(path: string): NextResponse {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error(`localRedirect: percorso non interno (${path})`);
  return new NextResponse(null, { status: 307, headers: { Location: path } });
}
