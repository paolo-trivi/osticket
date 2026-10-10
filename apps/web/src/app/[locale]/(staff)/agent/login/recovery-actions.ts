"use server";

import { getLocale } from "next-intl/server";

import { redirect } from "@/i18n/navigation";
import { isAgentPath, safeRedirectPath } from "@/server/actions/redirect-path";
import { cancelPendingLogin, completeMfaLogin, requestStaffPasswordReset, staffResetTokenLogin } from "@/server/auth/staff-recovery";

/** Server action di verifica 2FA e reset password degli agenti (scp/login.php do=2fa, scp/pwreset.php). */
export interface RecoveryState {
  error?: string;
  sent?: boolean;
  nonce?: number;
}

/** scp/login.php do=2fa */
export async function verifyMfaAction(_prev: RecoveryState, form: FormData): Promise<RecoveryState> {
  const r = await completeMfaLogin(String(form.get("token") ?? ""));
  const locale = await getLocale();
  if (r === "ok") {
    redirect({ href: safeRedirectPath(String(form.get("next") ?? ""), "/agent", isAgentPath), locale });
  }
  // Codice scaduto o troppi tentativi: logout e ritorno al login (ExpiredOTP)
  if (r !== "invalid") redirect({ href: "/agent/login?expired=1", locale });
  return { error: "invalid_code", nonce: Date.now() };
}

export async function cancelMfaAction(): Promise<void> {
  await cancelPendingLogin();
  redirect({ href: "/agent/login", locale: await getLocale() });
}

/** scp/pwreset.php do=sendmail: stessa risposta per agenti esistenti o no */
export async function requestResetAction(_prev: RecoveryState, form: FormData): Promise<RecoveryState> {
  const r = await requestStaffPasswordReset(String(form.get("userid") ?? ""));
  if (r.error)
    return {
      error: r.error === "read_only" ? "read_only" : r.error === "disabled" ? "reset_disabled" : "reset_unavailable",
      nonce: Date.now(),
    };
  return { sent: true, nonce: Date.now() };
}

/** scp/pwreset.php do=newpasswd: login con il token, poi cambio password obbligatorio */
export async function tokenLoginAction(_prev: RecoveryState, form: FormData): Promise<RecoveryState> {
  const r = await staffResetTokenLogin(String(form.get("userid") ?? ""), String(form.get("token") ?? ""));
  // un solo errore per utente o token sbagliati: non si rivela quali utenti esistono (il PHP li distingue)
  if (!r.ok) return { error: r.error === "invalid_user" ? "invalid_token" : r.error, nonce: Date.now() };
  redirect({ href: r.mfa ? "/agent/login/verify?next=/agent/profile?pwchange=1" : "/agent/profile?pwchange=1", locale: await getLocale() });
  return {};
}
