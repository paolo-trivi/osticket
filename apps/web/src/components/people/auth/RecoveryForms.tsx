"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";

import { cancelMfaAction, requestResetAction, tokenLoginAction, verifyMfaAction, type RecoveryState } from "@/app/[locale]/(staff)/agent/login/recovery-actions";
import Label from "@/components/form/Label";
import Input from "@/components/form/input/InputField";
import Alert from "@/components/ui/alert/Alert";
import Button from "@/components/ui/button/Button";
import { Link } from "@/i18n/navigation";

function Frame({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="flex w-full flex-1 flex-col lg:w-1/2">
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center">
        <div className="mb-5 sm:mb-8">
          <h1 className="mb-2 text-title-sm font-semibold text-gray-800 sm:text-title-md dark:text-white/90">{title}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">{subtitle}</p>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Verifica del codice 2FA al login (login.tpl.php con 2FA pendente). */
export function MfaVerifyForm({ next }: { next?: string }) {
  const t = useTranslations("peopleAuth");
  const [state, action, pending] = useActionState<RecoveryState, FormData>(verifyMfaAction, {});
  return (
    <Frame title={t("mfaTitle")} subtitle={t("mfaSubtitle")}>
      {state.error && (
        <div className="mb-5">
          <Alert variant="error" title={t(`errors.${state.error}`)} message="" />
        </div>
      )}
      <form action={action} className="space-y-6">
        <input type="hidden" name="next" value={next ?? ""} />
        <div>
          <Label htmlFor="token">
            {t("code")} <span className="text-error-500">*</span>
          </Label>
          <Input id="token" name="token" inputMode="numeric" pattern="[0-9]*" autoComplete="one-time-code" required autoFocus />
        </div>
        <Button type="submit" className="w-full" size="sm" disabled={pending}>
          {pending ? t("verifying") : t("verify")}
        </Button>
      </form>
      <form action={cancelMfaAction} className="mt-4 text-center">
        <button type="submit" className="text-sm text-brand-500 hover:text-brand-600 dark:text-brand-400">
          {t("cancel")}
        </button>
      </form>
    </Frame>
  );
}

/** Richiesta del link di reset (pwreset.php) o login con il token ricevuto (pwreset.login.php). */
export function ResetForms({ token }: { token?: string }) {
  const t = useTranslations("peopleAuth");
  const [req, reqAction, reqPending] = useActionState<RecoveryState, FormData>(requestResetAction, {});
  const [login, loginAction, loginPending] = useActionState<RecoveryState, FormData>(tokenLoginAction, {});
  if (token) {
    return (
      <Frame title={t("resetTitle")} subtitle={t("tokenSubtitle")}>
        {login.error && (
          <div className="mb-5">
            <Alert variant="error" title={t(`errors.${login.error}`)} message="" />
          </div>
        )}
        <form action={loginAction} className="space-y-6">
          <input type="hidden" name="token" value={token} />
          <div>
            <Label htmlFor="userid">
              {t("userid")} <span className="text-error-500">*</span>
            </Label>
            <Input id="userid" name="userid" autoComplete="username" required autoFocus />
          </div>
          <Button type="submit" className="w-full" size="sm" disabled={loginPending}>
            {loginPending ? t("verifying") : t("login")}
          </Button>
        </form>
      </Frame>
    );
  }
  return (
    <Frame title={t("resetTitle")} subtitle={req.sent ? t("sentSubtitle") : t("resetSubtitle")}>
      {req.error && (
        <div className="mb-5">
          <Alert variant="error" title={t(`errors.${req.error}`)} message="" />
        </div>
      )}
      {req.sent ? (
        <Alert variant="success" title={t("sent")} message={t("sentMessage")} />
      ) : (
        <form action={reqAction} className="space-y-6">
          <div>
            <Label htmlFor="userid">
              {t("userid")} <span className="text-error-500">*</span>
            </Label>
            <Input id="userid" name="userid" autoComplete="username" required autoFocus />
          </div>
          <Button type="submit" className="w-full" size="sm" disabled={reqPending}>
            {reqPending ? t("sending") : t("sendLink")}
          </Button>
        </form>
      )}
      <div className="mt-5 text-center text-sm">
        <Link href="/agent/login" className="text-brand-500 hover:text-brand-600 dark:text-brand-400">
          {t("backToLogin")}
        </Link>
      </div>
    </Frame>
  );
}
