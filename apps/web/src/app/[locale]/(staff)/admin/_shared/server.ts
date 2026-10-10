import "server-only";

import { getLocale } from "next-intl/server";

import { redirect } from "@/i18n/navigation";
import { clientIp } from "@/server/auth/session";
import { passwordChangeEnforced, sessionAgent, touchStaffSession } from "@/server/auth/staff-auth";
import { db, type Tx } from "@/server/db";
import type { Agent } from "@/server/domain/staff/staff";
import { requestPathForChanges, withChange, withChangeset } from "@/server/system/changes/changeset";
import { journalEnabled, requestOpForJournal } from "@/server/system/write-journal";
import { canWrite, isReadOnlyError, readOnlyResult, withWriteScope, type ReadOnlyResult } from "@/server/system/write-mode";

import { AGENT_PWCHANGE_HREF } from "../../agent/guard";

/**
 * Contesto delle server action dell'area admin: sessione ricontrollata e solo amministratori
 * (come scp/admin.inc.php). Senza permesso si torna al login/pannello agenti; con il cambio password
 * obbligatorio al profilo.
 */
export async function requireAdminAction(): Promise<{
  agent: Agent;
  ip: string;
  locale: string;
}> {
  const locale = await getLocale();
  const agent = await sessionAgent();
  if (!agent) redirect({ href: "/agent/login", locale });
  if (await passwordChangeEnforced(agent!)) redirect({ href: AGENT_PWCHANGE_HREF, locale });
  if (!agent!.isAdmin) redirect({ href: "/agent", locale });
  await touchStaffSession();
  return { agent: agent!, ip: await clientIp(), locale };
}

/**
 * Transazione di scrittura; gli invii email (send) partono dopo il commit. Scope di scrittura "admin"
 * (write-mode.ts): se la modalità non lo consente l'esito è readOnlyResult, senza query.
 * Ogni invocazione è una modifica registrata (changes/changeset.ts), annullabile dall'interfaccia: il
 * riferimento è associato all'esito (changeOf) e arriva al banner di conferma.
 */
export async function adminWrite<T>(fn: (tx: Tx) => Promise<T>, op?: string): Promise<T | ReadOnlyResult> {
  if (!(await canWrite("admin"))) return readOnlyResult();
  // attore del registro delle scritture e autore della modifica: l'agente della sessione (già letto da requireAdminAction)
  const agent = journalEnabled() ? await sessionAgent().catch(() => null) : null;
  const opName = op ?? (await requestOpForJournal());
  try {
    const { result, change } = await withChangeset({ staff: agent ? { id: agent.id, username: agent.username } : null, op: opName, path: await requestPathForChanges() }, () =>
      withWriteScope("admin", () => adminTx(fn), {
        actor: agent ? { type: "agent", id: agent.id } : undefined,
        op: opName,
      }),
    );
    return withChange(result, change);
  } catch (err) {
    if (isReadOnlyError(err)) return readOnlyResult();
    throw err;
  }
}

async function adminTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
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
