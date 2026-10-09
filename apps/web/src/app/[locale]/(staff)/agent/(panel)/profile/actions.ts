"use server";

import { revalidatePath } from "next/cache";

import type { PeopleActionState } from "@/components/people/types";
import { clientIp } from "@/server/auth/session";
import { currentAgent } from "@/server/auth/staff-auth";
import { refreshSessionAfterPasswordChange, sessionResetToken } from "@/server/auth/staff-recovery";
import { changeStaffPassword, setup2faEmail, updateStaffProfile, verify2faSetup } from "@/server/domain/staff/profile";
import { runWrite } from "@/server/domain/write";

/** Server action del profilo agente (scp/profile.php, ajax.staff.php changePassword / configure2FA). */

const nonce = () => Date.now();
const str = (form: FormData, k: string) => String(form.get(k) ?? "");

/** scp/profile.php (Staff::updateProfile) */
export async function profileUpdateAction(_prev: PeopleActionState, form: FormData): Promise<PeopleActionState> {
  const agent = await currentAgent();
  if (!agent) return { error: "session_expired" };
  const r = await runWrite({ agent, ip: await clientIp() }, (ctx) =>
    updateStaffProfile(ctx, {
      firstname: str(form, "firstname"),
      lastname: str(form, "lastname"),
      email: str(form, "email").trim(),
      phone: str(form, "phone"),
      phone_ext: str(form, "phone_ext"),
      mobile: str(form, "mobile"),
      signature: str(form, "signature"),
      timezone: str(form, "timezone"),
      locale: str(form, "locale"),
      max_page_size: str(form, "max_page_size"),
      auto_refresh_rate: str(form, "auto_refresh_rate"),
      default_signature_type: str(form, "default_signature_type"),
      default_paper_size: str(form, "default_paper_size"),
      lang: str(form, "lang"),
      onvacation: form.get("onvacation") === "1",
      datetime_format: str(form, "datetime_format"),
      default_from_name: str(form, "default_from_name"),
      default_2fa: str(form, "default_2fa"),
      thread_view_order: str(form, "thread_view_order"),
      default_ticket_queue_id: str(form, "default_ticket_queue_id") || "0",
      reply_redirect: str(form, "reply_redirect"),
      img_att_view: str(form, "img_att_view"),
      editor_spacing: str(form, "editor_spacing"),
    }),
  );
  if (!r.ok) return { error: r.error, fields: r.fields, nonce: nonce() };
  revalidatePath("/agent", "layout");
  return { ok: true, notice: "profile_saved", nonce: nonce() };
}

/**
 * ajax.staff.php:changePassword. Durante il reset con token la password attuale non è richiesta;
 * dopo il cambio la sessione corrente resta valida (il PHP esclude la propria sessione dalla pulizia).
 */
export async function passwordChangeAction(_prev: PeopleActionState, form: FormData): Promise<PeopleActionState> {
  const agent = await currentAgent();
  if (!agent) return { error: "session_expired" };
  const resetToken = await sessionResetToken();
  const r = await runWrite({ agent, ip: await clientIp() }, (ctx) =>
    changeStaffPassword(ctx, { current: str(form, "current"), passwd1: str(form, "passwd1"), passwd2: str(form, "passwd2"), resetToken }),
  );
  if (!r.ok) return { error: r.error, fields: r.fields as Record<string, string> | undefined, nonce: nonce() };
  await refreshSessionAfterPasswordChange(r.passwdreset);
  revalidatePath("/agent", "layout");
  return { ok: true, notice: "password_changed", redirect: resetToken ? "/agent" : undefined, nonce: nonce() };
}

const setupKey = (staffId: number) => `setup:${staffId}`;

/** ajax.staff.php:configure2FA stato "validate": salva l'indirizzo e invia il codice di verifica. */
export async function twofaSetupAction(_prev: PeopleActionState, form: FormData): Promise<PeopleActionState> {
  const agent = await currentAgent();
  if (!agent) return { error: "session_expired" };
  const r = await runWrite({ agent, ip: await clientIp() }, (ctx) => setup2faEmail(ctx, str(form, "email").trim(), setupKey(agent.id)));
  if (!r.ok) return { error: r.error === "invalid" ? "invalid" : r.error, fields: r.error === "invalid" ? { email: "email" } : undefined, nonce: nonce() };
  try {
    await r.send();
  } catch {
    return { error: "send_failed", nonce: nonce() };
  }
  return { ok: true, notice: "token_sent", nonce: nonce() };
}

/** configure2FA stato "verify": codice corretto → configurazione verificata. */
export async function twofaVerifyAction(_prev: PeopleActionState, form: FormData): Promise<PeopleActionState> {
  const agent = await currentAgent();
  if (!agent) return { error: "session_expired" };
  const r = await runWrite({ agent, ip: await clientIp() }, (ctx) => verify2faSetup(ctx, setupKey(agent.id), str(form, "token")));
  if (r !== "ok") return { error: r === "invalid" ? "invalid_code" : r === "missing" ? "code_missing" : "code_expired", nonce: nonce() };
  revalidatePath("/agent/profile");
  return { ok: true, notice: "twofa_verified", nonce: nonce() };
}
