import "server-only";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";

import type { SysFormState } from "@/components/adminsys/SysForm";
import type { PeopleActionState } from "@/components/people/types";
import { redirect } from "@/i18n/navigation";
import type { AdminFormState } from "@/lib/admin/form-schema";
import type { MassResult, SaveResult } from "@/server/domain/admin/common";

/**
 * Esiti delle server action: stato restituito ai form (useActionState) e ritorno alle liste dopo le
 * azioni di massa dell'area admin.
 */

/** Valore sempre nuovo nello stato restituito: il client riconosce anche due esiti uguali di fila. */
export const nonce = () => Date.now();

/** Esito di un'azione dei form "people" (utenti, organizzazioni) a partire dal risultato del dominio. */
export function peopleState(r: { ok: true } | { ok: false; error: string; fields?: Record<string, string> }, redirectTo?: string): PeopleActionState {
  if (r.ok) return { ok: true, redirect: redirectTo, nonce: nonce() };
  return { error: r.error, fields: r.fields, nonce: nonce() };
}

/** Dopo un salvataggio admin riuscito: cache dell'area invalidata e, dopo una creazione, pagina dell'oggetto. */
function afterAdminSave(r: SaveResult, opts: { locale: string; created?: (id: number) => string }): void {
  revalidatePath("/[locale]/admin", "layout");
  if (opts.created && r.id) redirect({ href: opts.created(r.id), locale: opts.locale });
}

/** Esito di un salvataggio per AdminForm (codici d'errore del dominio, tradotti dal client). */
export async function adminFormResult(r: SaveResult, opts: { locale: string; created?: (id: number) => string }): Promise<AdminFormState> {
  if (!r.ok) return { status: "error", errors: Object.keys(r.errors).length ? r.errors : { err: "failed" }, nonce: nonce() };
  afterAdminSave(r, opts);
  return { status: "saved", nonce: nonce() };
}

/** Traduzione dei codici d'errore del dominio (i messaggi non codificati restano invariati). */
async function translateErrors(errors: Record<string, string>): Promise<Record<string, string>> {
  const e = await getTranslations("asys.errors");
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(errors)) out[k] = e.has(v) ? e(v) : v;
  return out;
}

/** Esito di un salvataggio per SysForm (errori già tradotti, `err` come messaggio generale). */
export async function sysFormResult(r: SaveResult, opts: { locale: string; created?: (id: number) => string; message?: string }): Promise<SysFormState> {
  if (!r.ok) {
    const errors = await translateErrors(r.errors);
    const e = await getTranslations("asys.errors");
    const general = errors.err;
    delete errors.err;
    return { status: "error", errors, message: general ?? (Object.keys(errors).length ? undefined : e("failed")), nonce: nonce() };
  }
  afterAdminSave(r, opts);
  return { status: "saved", message: opts.message, nonce: nonce() };
}

/** Dopo un'azione di massa: ritorno alla lista con l'esito in query string (?ok=<azione>&n=<num> o ?err=<codice>). */
export function massRedirect(path: string, locale: string, r: MassResult, action: string): never {
  revalidatePath("/[locale]/admin", "layout");
  const sep = path.includes("?") ? "&" : "?";
  const q = r.ok ? `${sep}ok=${encodeURIComponent(action)}&n=${r.num}` : `${sep}err=${encodeURIComponent(r.error ?? "failed")}`;
  redirect({ href: `${path}${q}`, locale });
  throw new Error("redirect");
}
