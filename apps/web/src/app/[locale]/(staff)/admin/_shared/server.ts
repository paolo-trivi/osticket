import "server-only";

import { getLocale } from "next-intl/server";

import { redirect } from "@/i18n/navigation";
import { clientIp } from "@/server/auth/session";
import { sessionAgent, touchStaffSession } from "@/server/auth/staff-auth";
import { db, type Tx } from "@/server/db";
import type { Agent } from "@/server/domain/staff/staff";

import { AGENT_PWCHANGE_HREF } from "../../agent/guard";

/**
 * Contesto delle server action dell'area admin: sessione ricontrollata e solo amministratori
 * (come scp/admin.inc.php). Senza permesso si torna al login/pannello agenti; con il cambio password
 * obbligatorio al profilo.
 */
export async function requireAdminAction(): Promise<{ agent: Agent; ip: string; locale: string }> {
  const locale = await getLocale();
  const agent = await sessionAgent();
  if (!agent) redirect({ href: "/agent/login", locale });
  if (agent!.mustChangePassword) redirect({ href: AGENT_PWCHANGE_HREF, locale });
  if (!agent!.isAdmin) redirect({ href: "/agent", locale });
  await touchStaffSession();
  return { agent: agent!, ip: await clientIp(), locale };
}

/** Transazione di scrittura; gli invii email (send) partono dopo il commit. */
export async function adminWrite<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const res = await db().transaction().execute(fn);
  const send = (res as { send?: () => Promise<void> } | null)?.send;
  if (send) {
    try {
      await send();
    } catch (err) {
      console.error("[admin] invio email fallito", err);
    }
  }
  return res;
}
