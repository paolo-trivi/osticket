import "server-only";

import { redirect } from "@/i18n/navigation";
import type { Agent } from "@/server/domain/staff/staff";

import { requireAgent } from "../agent/guard";

/** Area amministrazione: come scp/admin.inc.php, solo agenti con isadmin. */
export async function requireAdmin(locale: string): Promise<Agent> {
  const agent = await requireAgent(locale);
  if (!agent.isAdmin) redirect({ href: "/agent", locale });
  return agent;
}
