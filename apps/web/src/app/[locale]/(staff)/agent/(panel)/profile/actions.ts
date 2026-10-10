"use server";

import { revalidatePath } from "next/cache";

import type { PeopleActionState } from "@/components/people/types";
import { formFlag, formStr } from "@/server/actions/form-data";
import { nonce } from "@/server/actions/result";
import { clientIp } from "@/server/auth/session";
import { currentAgent } from "@/server/auth/staff-auth";
import { refreshSessionAfterPasswordChange, sessionResetToken } from "@/server/auth/staff-recovery";
import { changeStaffPassword, updateStaffProfile } from "@/server/domain/staff/profile";
import { setup2faEmail, verify2faSetup } from "@/server/domain/staff/two-factor";
import { runWrite } from "@/server/domain/write";

/** Server action del profilo agente (scp/profile.php, ajax.staff.php changePassword / configure2FA). */

/** scp/profile.php (Staff::updateProfile) */
export async function profileUpdateAction(_prev: PeopleActionState, form: FormData): Promise<PeopleActionState> {
  const agent = await currentAgent();
  if (!agent) return { error: "session_expired" };
  const r = await runWrite({ agent, ip: await clientIp() }, (ctx) =>
    updateStaffProfile(ctx, {
      firstname: formStr(form, "firstname"),
      lastname: formStr(form, "lastname"),
      email: formStr(form, "email").trim(),
      phone: formStr(form, "phone"),
      phone_ext: formStr(form, "phone_ext"),
      mobile: formStr(form, "mobile"),
      signature: formStr(form, "signature"),
      timezone: formStr(form, "timezone"),
      locale: formStr(form, "locale"),
      max_page_size: formStr(form, "max_page_size"),
      auto_refresh_rate: formStr(form, "auto_refresh_rate"),
      default_signature_type: formStr(form, "default_signature_type"),
      default_paper_size: formStr(form, "default_paper_size"),
      lang: formStr(form, "lang"),
      onvacation: formFlag(form, "onvacation"),
      datetime_format: formStr(form, "datetime_format"),
      default_from_name: formStr(form, "default_from_name"),
      default_2fa: formStr(form, "default_2fa"),
      thread_view_order: formStr(form, "thread_view_order"),
      default_ticket_queue_id: formStr(form, "default_ticket_queue_id") || "0",
      reply_redirect: formStr(form, "reply_redirect"),
      img_att_view: formStr(form, "img_att_view"),
      editor_spacing: formStr(form, "editor_spacing"),
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
    changeStaffPassword(ctx, { current: formStr(form, "current"), passwd1: formStr(form, "passwd1"), passwd2: formStr(form, "passwd2"), resetToken }),
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
  const r = await runWrite({ agent, ip: await clientIp() }, (ctx) => setup2faEmail(ctx, formStr(form, "email").trim(), setupKey(agent.id)));
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
  const r = await runWrite({ agent, ip: await clientIp() }, (ctx) => verify2faSetup(ctx, setupKey(agent.id), formStr(form, "token")));
  if (r !== "ok") return { error: r === "invalid" ? "invalid_code" : r === "missing" ? "code_missing" : "code_expired", nonce: nonce() };
  revalidatePath("/agent/profile");
  return { ok: true, notice: "twofa_verified", nonce: nonce() };
}
