import "server-only";

import { getLocale } from "next-intl/server";
import { revalidatePath } from "next/cache";

import { redirect } from "@/i18n/navigation";
import type { AdminFormState } from "@/lib/admin/form-schema";
import { clientIp } from "@/server/auth/session";
import { currentAgent, touchStaffSession } from "@/server/auth/staff-auth";
import { db, type Tx } from "@/server/db";
import type { MassResult, SaveResult } from "@/server/domain/admin/common";
import type { Agent } from "@/server/domain/staff/staff";

/**
 * Contesto delle server action dell'area admin: sessione ricontrollata e solo amministratori
 * (come scp/admin.inc.php). Senza permesso si torna al login/pannello agenti.
 */
export async function requireAdminAction(): Promise<{ agent: Agent; ip: string; locale: string }> {
  const locale = await getLocale();
  const agent = await currentAgent();
  if (!agent) redirect({ href: "/agent/login", locale });
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

/** Esito di un salvataggio per il form; dopo una creazione si va alla pagina dell'oggetto. */
export async function formResult(r: SaveResult, opts: { path: string; created?: (id: number) => string; locale: string }): Promise<AdminFormState> {
  if (!r.ok) return { status: "error", errors: Object.keys(r.errors).length ? r.errors : { err: "failed" }, nonce: Date.now() };
  revalidatePath(`/[locale]/admin`, "layout");
  if (opts.created && r.id) redirect({ href: opts.created(r.id), locale: opts.locale });
  return { status: "saved", nonce: Date.now() };
}

/** Dopo un'azione di massa: ritorno alla lista con l'esito in query string. */
export function massRedirect(path: string, locale: string, r: MassResult, action: string): never {
  revalidatePath(`/[locale]/admin`, "layout");
  const q = r.ok ? `?ok=${encodeURIComponent(action)}&n=${r.num}` : `?err=${encodeURIComponent(r.error ?? "failed")}`;
  redirect({ href: `${path}${q}`, locale });
  throw new Error("redirect");
}
