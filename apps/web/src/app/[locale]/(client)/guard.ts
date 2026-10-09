import "server-only";

import { redirect } from "@/i18n/navigation";
import { currentClient } from "@/server/auth/client-auth";
import { AccountStatus, type ClientIdentity } from "@/server/domain/client/identity";

/**
 * Protezione delle pagine del portale (secure.inc.php): cliente autenticato, altrimenti login con
 * ritorno alla pagina richiesta. Con il cambio password obbligatorio (client.inc.php) si resta sul
 * profilo. Da chiamare in ogni pagina protetta.
 */
export async function requireClient(locale: string, next: string, opts: { allowGuest?: boolean; skipPwCheck?: boolean } = {}): Promise<ClientIdentity> {
  const client = await currentClient();
  if (!client) redirect({ href: `/login?next=${encodeURIComponent(next)}`, locale });
  const c = client as ClientIdentity;
  if (c.guest && opts.allowGuest === false) redirect({ href: `/tickets/${c.guest.ticketId}`, locale });
  if (!opts.skipPwCheck && c.account && c.account.status & AccountStatus.REQUIRE_PASSWD_RESET) redirect({ href: "/profile?pwchange=1", locale });
  return c;
}
