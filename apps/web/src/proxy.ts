import createMiddleware from "next-intl/middleware";
import { NextRequest, NextResponse } from "next/server";

import { routing } from "./i18n/routing";
import { buildCsp } from "./server/security/csp";

const intl = createMiddleware(routing);

/**
 * 1. CSP con nonce per ogni pagina: il nonce viaggia nella richiesta (x-nonce + content-security-policy,
 *    da cui Next lo applica ai propri script) e nella risposta.
 * 2. next-intl con localePrefix "never": gli URL pubblici non hanno la lingua, il middleware li riscrive su
 *    /<locale>/… . Con un basePath (es. /app dietro reverse proxy) la richiesta riscritta ripassa dal
 *    middleware, che la reindirizzerebbe di nuovo all'URL senza lingua (loop): i percorsi che contengono
 *    già la lingua passano quindi senza ulteriori trasformazioni.
 */
export default function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = buildCsp(nonce);
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", csp);

  const first = request.nextUrl.pathname.split("/")[1];
  const response = (routing.locales as readonly string[]).includes(first)
    ? NextResponse.next({ request: { headers } })
    : intl(new NextRequest(request, { headers }));
  response.headers.set("content-security-policy", csp);
  return response;
}

export const config = {
  matcher: ["/((?!api/|_next|_vercel|.*\\..*).*)"],
};
