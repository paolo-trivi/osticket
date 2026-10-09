import createMiddleware from "next-intl/middleware";
import { NextResponse, type NextRequest } from "next/server";

import { routing } from "./i18n/routing";

const intl = createMiddleware(routing);

/**
 * next-intl con localePrefix "never": gli URL pubblici non hanno la lingua, il middleware li riscrive
 * internamente su /<locale>/… . Con un basePath (es. /app dietro reverse proxy) la richiesta riscritta
 * ripassa dal middleware, che la reindirizzerebbe di nuovo all'URL senza lingua (loop di redirect):
 * i percorsi che contengono già la lingua passano quindi senza ulteriori trasformazioni.
 */
export default function proxy(request: NextRequest) {
  const first = request.nextUrl.pathname.split("/")[1];
  if ((routing.locales as readonly string[]).includes(first)) return NextResponse.next();
  return intl(request);
}

export const config = {
  matcher: ["/((?!api/|_next|_vercel|.*\\..*).*)"],
};
