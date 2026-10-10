import "server-only";

import { redirect } from "@/i18n/navigation";
import { sessionAgent } from "@/server/auth/staff-auth";
import type { Agent } from "@/server/domain/staff/staff";

/** Pagina del cambio password obbligatorio (profilo dell'agente). */
export const AGENT_PWCHANGE_HREF = "/agent/profile?pwchange=1";

/**
 * Agente autenticato oppure redirect al login. Va chiamato sia nel layout sia in ogni pagina:
 * Next renderizza layout e pagina in parallelo, il redirect del layout non protegge la pagina.
 * Con il cambio password obbligatorio (staff.change_passwd, scp/staff.inc.php) si resta sul profilo:
 * solo il profilo (e il layout che lo contiene) passa `passwordChange: true`.
 */
export async function requireAgent(locale: string, opts: { passwordChange?: boolean } = {}): Promise<Agent> {
  const agent = await sessionAgent();
  if (!agent) redirect({ href: "/agent/login?expired=1", locale });
  if (agent!.mustChangePassword && !opts.passwordChange) redirect({ href: AGENT_PWCHANGE_HREF, locale });
  return agent!;
}
