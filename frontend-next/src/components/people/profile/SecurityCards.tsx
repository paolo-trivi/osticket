"use client";

import { useTranslations } from "next-intl";
import { useActionState, useEffect } from "react";

import { passwordChangeAction, twofaSetupAction, twofaVerifyAction } from "@/app/[locale]/(staff)/agent/(panel)/profile/actions";
import ComponentCard from "@/components/common/ComponentCard";
import Button from "@/components/ui/button/Button";
import { useRouter } from "@/i18n/navigation";

import { FormAlert, TextField } from "../FormControls";
import type { PeopleActionState } from "../types";

function useErr(state: PeopleActionState) {
  const tu = useTranslations("peopleUi");
  return state.error ? (tu.has(`errors.${state.error}`) ? tu(`errors.${state.error}`) : tu("errors.generic")) : "";
}

/** Cambio password (PasswordChangeForm): senza password attuale durante il reset con token. */
export function PasswordCard({ withToken, forced }: { withToken: boolean; forced: boolean }) {
  const t = useTranslations("peopleProfile");
  const tu = useTranslations("peopleUi");
  const router = useRouter();
  const [state, action, pending] = useActionState<PeopleActionState, FormData>(passwordChangeAction, {});
  useEffect(() => {
    if (!state.ok) return;
    if (state.redirect) router.push(state.redirect);
    else router.refresh();
  }, [state, router]);
  const error = useErr(state);
  const f = state.fields ?? {};
  return (
    <ComponentCard title={t("changePassword")} desc={forced ? t("mustChangePassword") : t("changePasswordHint")}>
      <form action={action} className="space-y-4">
        {error && <FormAlert kind="error">{error}</FormAlert>}
        {state.ok && <FormAlert kind="success">{t("passwordChanged")}</FormAlert>}
        {!withToken && <TextField name="current" type="password" label={t("currentPassword")} autoComplete="current-password" error={f.current} />}
        <TextField name="passwd1" type="password" label={t("newPassword")} autoComplete="new-password" error={f.passwd1} maxLength={128} />
        <TextField name="passwd2" type="password" label={t("confirmPassword")} autoComplete="new-password" error={f.passwd2} maxLength={128} />
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? tu("working") : t("updatePassword")}
          </Button>
        </div>
      </form>
    </ComponentCard>
  );
}

/** Configurazione del 2FA via email (ajax.staff.php:configure2FA): indirizzo → codice → verifica. */
export function TwoFactorCard({ email, verified }: { email: string; verified: boolean }) {
  const t = useTranslations("peopleProfile");
  const tu = useTranslations("peopleUi");
  const router = useRouter();
  const [setup, setupAction, setupPending] = useActionState<PeopleActionState, FormData>(twofaSetupAction, {});
  const [verify, verifyAction, verifyPending] = useActionState<PeopleActionState, FormData>(twofaVerifyAction, {});
  useEffect(() => {
    if (verify.ok) router.refresh();
  }, [verify, router]);
  const setupErr = useErr(setup);
  const verifyErr = useErr(verify);
  // dopo un codice scaduto o troppi tentativi si torna all'invio (il PHP chiude il dialogo)
  const expired = verify.error === "code_expired" || verify.error === "code_missing";
  const sent = !!setup.ok && !verify.ok && (!expired || (setup.nonce ?? 0) > (verify.nonce ?? 0));
  return (
    <ComponentCard title={t("twofa")} desc={verified ? t("twofaConfigured") : t("twofaHint")}>
      <div className="space-y-4">
        {verify.ok && <FormAlert kind="success">{t("twofaVerified")}</FormAlert>}
        {!sent ? (
          <form action={setupAction} className="space-y-4">
            {setupErr && <FormAlert kind="error">{setupErr}</FormAlert>}
            <TextField name="email" type="email" label={t("twofaEmail")} defaultValue={email} hint={t("twofaEmailHint")} error={setup.fields?.email} />
            <div className="flex justify-end">
              <Button type="submit" size="sm" disabled={setupPending}>
                {setupPending ? tu("working") : t("sendCode")}
              </Button>
            </div>
          </form>
        ) : (
          <form action={verifyAction} className="space-y-4">
            <FormAlert kind="info">{t("codeSent")}</FormAlert>
            {verifyErr && <FormAlert kind="error">{verifyErr}</FormAlert>}
            <TextField name="token" label={t("verificationCode")} autoComplete="one-time-code" />
            <div className="flex justify-end">
              <Button type="submit" size="sm" disabled={verifyPending}>
                {verifyPending ? tu("working") : t("verify")}
              </Button>
            </div>
          </form>
        )}
      </div>
    </ComponentCard>
  );
}
