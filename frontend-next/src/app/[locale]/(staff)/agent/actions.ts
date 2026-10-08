"use server";

import { getLocale } from "next-intl/server";

import { redirect } from "@/i18n/navigation";
import { staffLogin, staffLogout, type StaffLoginResult } from "@/server/auth/staff-auth";

export interface LoginState {
  error?: Extract<StaffLoginResult, { ok: false }>["error"];
  username?: string;
}

export async function agentLoginAction(_prev: LoginState, form: FormData): Promise<LoginState> {
  const username = String(form.get("username") ?? "");
  const password = String(form.get("password") ?? "");
  const result = await staffLogin(username, password);
  if (!result.ok) return { error: result.error, username };

  const next = String(form.get("next") ?? "");
  const locale = await getLocale();
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
