"use client";

import Label from "@/components/form/Label";
import Input from "@/components/form/input/InputField";
import Alert from "@/components/ui/alert/Alert";
import Button from "@/components/ui/button/Button";
import { EyeCloseIcon, EyeIcon } from "@/icons";
import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";

import ForgotPasswordLink from "@/components/people/auth/ForgotPasswordLink";

import { agentLoginAction, type LoginState } from "../actions";

export default function LoginForm({ next, expired }: { next?: string; expired?: boolean }) {
  const t = useTranslations("auth");
  const [state, action, pending] = useActionState<LoginState, FormData>(agentLoginAction, {});
  const [showPassword, setShowPassword] = useState(false);

  return (
    <div className="flex w-full flex-1 flex-col lg:w-1/2">
      <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center">
        <div className="mb-5 sm:mb-8">
          <h1 className="mb-2 text-title-sm font-semibold text-gray-800 sm:text-title-md dark:text-white/90">
            {t("agentLoginTitle")}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400">{t("agentLoginSubtitle")}</p>
        </div>

        {state.error && (
          <div className="mb-5">
            <Alert variant="error" title={t(`errors.${state.error}`)} message="" />
          </div>
        )}
        {!state.error && expired && (
          <div className="mb-5">
            <Alert variant="warning" title={t("sessionExpired")} message="" />
          </div>
        )}

        <form action={action}>
          <input type="hidden" name="next" value={next ?? ""} />
          <div className="space-y-6">
            <div>
              <Label htmlFor="username">
                {t("username")} <span className="text-error-500">*</span>
              </Label>
              <Input
                id="username"
                name="username"
                autoComplete="username"
                defaultValue={state.username}
                required
                autoFocus
              />
            </div>
            <div>
              <Label htmlFor="password">
                {t("password")} <span className="text-error-500">*</span>
              </Label>
              <div className="relative">
                <Input
                  id="password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute end-4 top-1/2 z-30 -translate-y-1/2 cursor-pointer"
                  aria-label="password"
                >
                  {showPassword ? (
                    <EyeIcon className="fill-gray-500 dark:fill-gray-400" />
                  ) : (
                    <EyeCloseIcon className="fill-gray-500 dark:fill-gray-400" />
                  )}
                </button>
              </div>
            </div>
            <Button type="submit" className="w-full" size="sm" disabled={pending}>
              {pending ? t("signingIn") : t("signIn")}
            </Button>
            <ForgotPasswordLink />
          </div>
        </form>
      </div>
    </div>
  );
}
