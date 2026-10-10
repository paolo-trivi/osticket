"use server";

import { getLocale } from "next-intl/server";

import { redirect } from "@/i18n/navigation";
import { formStr } from "@/server/actions/form-data";
import { staffLogin, staffLogout, type StaffLoginResult } from "@/server/auth/staff-auth";

export interface LoginState {
  error?: Extract<StaffLoginResult, { ok: false }>["error"];
  username?: string;
}

export async function agentLoginAction(_prev: LoginState, form: FormData): Promise<LoginState> {
  const username = formStr(form, "username");
  const password = formStr(form, "password");
  const result = await staffLogin(username, password);
  if (!result.ok) return { error: result.error, username };

  const next = formStr(form, "next");
  const locale = await getLocale();
  // 2FA via email: secondo passo con il codice inviato (area people, login/verify)
  if (result.mfa) {
    const after = result.mustChangePassword ? "/agent/profile?pwchange=1" : next;
    redirect({ href: `/agent/login/verify${after ? `?next=${encodeURIComponent(after)}` : ""}`, locale });
  }
  // Solo percorsi interni del pannello (niente open redirect)
  const dest = result.mustChangePassword
    ? "/agent/profile?pwchange=1"
    : next.startsWith("/agent") && !next.startsWith("//")
      ? next
      : "/agent";
  redirect({ href: dest, locale });
  return {};
}

export async function agentLogoutAction(): Promise<void> {
  await staffLogout();
  redirect({ href: "/agent/login", locale: await getLocale() });
}
