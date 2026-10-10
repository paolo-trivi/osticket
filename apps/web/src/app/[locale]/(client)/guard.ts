import "server-only";

import { redirect } from "@/i18n/navigation";
import { clientMustChangePassword, currentClient, sessionClient } from "@/server/auth/client-auth";
import type { ClientIdentity } from "@/server/domain/client/identity";

const PWCHANGE_HREF = "/profile?pwchange=1";

/**
 * Protezione delle pagine del portale (secure.inc.php): cliente autenticato, altrimenti login con
 * ritorno alla pagina richiesta. Con il cambio password obbligatorio (client.inc.php) si resta sul
 * profilo: solo il profilo passa `skipPwCheck`. Da chiamare in ogni pagina protetta.
 */
export async function requireClient(locale: string, next: string, opts: { allowGuest?: boolean; skipPwCheck?: boolean } = {}): Promise<ClientIdentity> {
  const client = await sessionClient();
  if (!client) redirect({ href: `/login?next=${encodeURIComponent(next)}`, locale });
  const c = client as ClientIdentity;
  if (c.guest && opts.allowGuest === false) redirect({ href: `/tickets/${c.guest.ticketId}`, locale });
  if (!opts.skipPwCheck && clientMustChangePassword(c)) redirect({ href: PWCHANGE_HREF, locale });
  return c;
}

/**
 * Pagine pubbliche del portale (home, apertura ticket, knowledge base, login, registrazione): cliente
 * della sessione o null; con il cambio password obbligatorio in sospeso si va al profilo, come
 * client.inc.php per ogni pagina.
 */
export async function portalVisitor(locale: string): Promise<ClientIdentity | null> {
  const session = await sessionClient();
  if (session && clientMustChangePassword(session)) redirect({ href: PWCHANGE_HREF, locale });
  return currentClient();
}
