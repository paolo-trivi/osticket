"use client";

import { useActionState } from "react";

import { useTranslations } from "next-intl";

import Label from "@/components/form/Label";
import Input from "@/components/form/input/InputField";
import Alert from "@/components/ui/alert/Alert";

import { pwresetLoginAction, pwresetRequestAction, type ResetState } from "@/app/[locale]/(client)/actions";

/** pwreset.php: richiesta del link (pwreset.request.php) o accesso con il token (pwreset.login.php). */
export default function ResetForms({ token }: { token?: string }) {
  const t = useTranslations("portal.pwreset");
  const te = useTranslations("portal.errors");
  const [state, action, pending] = useActionState<ResetState, FormData>(token ? pwresetLoginAction : pwresetRequestAction, {});
  if (state.sent) return <Alert variant="success" title={t("sent")} message={t("sentText")} />;
  return (
    <form action={action} className="max-w-md space-y-5 rounded-2xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-white/3">
      <p className="text-sm text-gray-500 dark:text-gray-400">{token ? t("loginText") : t("requestText")}</p>
      {state.error && <Alert variant="error" title={te.has(state.error) ? te(state.error) : state.error} message="" />}
      {token && <input type="hidden" name="token" value={token} />}
      <div>
        <Label htmlFor="userid">{t("userid")}</Label>
        <Input id="userid" name="userid" autoComplete="username" required />
      </div>
      <button type="submit" disabled={pending} className="h-11 w-full rounded-lg bg-brand-500 px-5 text-sm font-medium text-white shadow-theme-xs hover:bg-brand-600 disabled:opacity-60">
        {token ? t("login") : t("send")}
      </button>
    </form>
  );
}
