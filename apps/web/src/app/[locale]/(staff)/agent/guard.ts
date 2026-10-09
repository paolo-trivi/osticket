import "server-only";

import { redirect } from "@/i18n/navigation";
import { currentAgent } from "@/server/auth/staff-auth";
import type { Agent } from "@/server/domain/staff/staff";

/**
 * Agente autenticato oppure redirect al login. Va chiamato sia nel layout sia in ogni pagina:
 * Next renderizza layout e pagina in parallelo, il redirect del layout non protegge la pagina.
 */
export async function requireAgent(locale: string): Promise<Agent> {
  const agent = await currentAgent();
  if (!agent) redirect({ href: "/agent/login?expired=1", locale });
  return agent!;
}
