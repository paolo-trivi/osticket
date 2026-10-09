import "server-only";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";

import type { SysFormState } from "@/components/adminsys/SysForm";
import { redirect } from "@/i18n/navigation";
import type { MassResult, SaveResult } from "@/server/domain/admin/common";
import { parsePhpForm, selectedIds } from "@/server/domain/admin/form-data";
import type { DbDateTime } from "@/server/db/schema.gen";
import type { Agent } from "@/server/domain/staff/staff";
import { agentTimeZone, formatDbDate, type DateStyle } from "@/server/format/datetime";

import { adminWrite, requireAdminAction } from "../_shared/server";

/**
 * Supporto alle server action dell'area admin di sistema (email, filtri, form, liste, pagine,
 * code, API key, log, plugin): sessione e isadmin ricontrollati a ogni chiamata
 * (requireAdminAction), scrittura in transazione, errori del dominio tradotti (asys.errors).
 */
export { adminWrite, parsePhpForm, requireAdminAction, selectedIds };

/** Traduzione dei codici d'errore del dominio (i messaggi non codificati restano invariati). */
async function translateErrors(errors: Record<string, string>): Promise<Record<string, string>> {
  const e = await getTranslations("asys.errors");
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(errors)) out[k] = e.has(v) ? e(v) : v;
  return out;
}

/** Esito di un salvataggio per SysForm; dopo una creazione si va alla pagina dell'oggetto. */
export async function formResult(r: SaveResult, opts: { locale: string; created?: (id: number) => string; message?: string }): Promise<SysFormState> {
  if (!r.ok) {
    const errors = await translateErrors(r.errors);
    const e = await getTranslations("asys.errors");
    const general = errors.err;
    delete errors.err;
    return { status: "error", errors, message: general ?? (Object.keys(errors).length ? undefined : e("failed")), nonce: Date.now() };
  }
  revalidatePath("/[locale]/admin", "layout");
  if (opts.created && r.id) redirect({ href: opts.created(r.id), locale: opts.locale });
  return { status: "saved", message: opts.message, nonce: Date.now() };
}

/** Dopo un'azione di massa: ritorno alla lista con l'esito in query string. */
export function massRedirect(path: string, locale: string, r: MassResult, action: string): never {
  revalidatePath("/[locale]/admin", "layout");
  const sep = path.includes("?") ? "&" : "?";
  const q = r.ok ? `${sep}ok=${encodeURIComponent(action)}&n=${r.num}` : `${sep}err=${encodeURIComponent(r.error ?? "failed")}`;
  redirect({ href: `${path}${q}`, locale });
  throw new Error("redirect");
}

/** Formattatore delle date del DB nel fuso dell'agente (Format::datetime). */
export async function dateFormatter(agent: Agent, locale: string): Promise<(v: unknown, style?: DateStyle) => string> {
  const tz = await agentTimeZone(agent);
  return (v, style = "short") => (v ? formatDbDate(String(v) as DbDateTime, tz, locale, style) : "—");
}
