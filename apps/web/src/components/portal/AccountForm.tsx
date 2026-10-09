"use client";

import { useActionState, useEffect, useMemo, useRef } from "react";

import { useTranslations } from "next-intl";

import DynamicForm from "@/components/forms/dynamic/DynamicForm";
import FieldShell from "@/components/forms/dynamic/FieldShell";
import { inputCls, selectCls } from "@/components/forms/dynamic/styles";
import Alert from "@/components/ui/alert/Alert";
import { Link } from "@/i18n/navigation";
import type { DynamicFormView } from "@/lib/forms/dynamic-field";

import { profileAction, registerAction, type ProfileState, type RegisterState } from "@/app/[locale]/(client)/actions";

interface Props {
  mode: "register" | "profile";
  userForm: DynamicFormView | null;
  /** valori iniziali del form utente (chiavi f.<id>) */
  values: Record<string, string[]>;
  timezone: string;
  lang?: string;
  languages: { code: string; label: string }[];
  /** campi password: sempre in registrazione; nel profilo se il reset è consentito */
  showPassword: boolean;
  /** password attuale richiesta (profilo senza token di reset) */
  requireCurrent: boolean;
  /** campo email non modificabile (ospite che si registra) */
  lockEmail?: boolean;
  notice?: string;
  /** pagina "registration-confirm" mostrata dopo la registrazione */
  doneContent?: { title: string; html: string } | null;
}

/** Form account (register.inc.php) e profilo (profile.inc.php) del cliente. */
export default function AccountForm({ mode, userForm, values, timezone, lang, languages, showPassword, requireCurrent, lockEmail, notice, doneContent }: Props) {
  const t = useTranslations("portal.account");
  const te = useTranslations("portal.errors");
  const tf = useTranslations("portal.fieldErrors");
  const [state, action, pending] = useActionState<RegisterState | ProfileState, FormData>(mode === "register" ? registerAction : profileAction, {});
  const tzRef = useRef<HTMLSelectElement>(null);
  // register.inc.php: fuso rilevato dal browser (jstz) se non indicato
  useEffect(() => {
    const el = tzRef.current;
    if (mode === "register" && el && !el.value) {
      try {
        el.value = Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch {
        /* fuso non rilevabile: resta il predefinito di sistema */
      }
    }
  }, [mode]);
  const zones = useMemo(() => {
    try {
      return Intl.supportedValuesOf("timeZone");
    } catch {
      return [timezone].filter(Boolean);
    }
  }, [timezone]);

  if ("done" in state && state.done) {
    return (
      <section className="rounded-2xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-white/3">
        <h2 className="text-title-sm font-semibold text-gray-800 dark:text-white/90">{doneContent?.title || t("registered")}</h2>
        {doneContent ? (
          <div className="mt-3 text-sm text-gray-600 dark:text-gray-300" dangerouslySetInnerHTML={{ __html: doneContent.html }} />
        ) : (
          <p className="mt-3 text-sm text-gray-600 dark:text-gray-300">{t("registeredText")}</p>
        )}
      </section>
    );
  }

  const fieldErr = (k: string) => {
    const code = state.fields?.[k];
    return code ? [tf.has(code) ? tf(code) : code] : undefined;
  };
  // Errori dei campi del form utente (per nome) → id del campo per i renderer
  const dynErrors: Record<number, string[]> = {};
  for (const f of userForm?.fields ?? []) {
    const code = state.fields?.[f.name] ?? state.fields?.[String(f.id)];
    if (code) dynErrors[f.id] = [code];
  }
  const vals = state.values ? Object.fromEntries(Object.entries(state.values).map(([k, v]) => [k, [v]])) : values;
  const hidden = lockEmail ? (userForm?.fields.filter((f) => f.name === "email").map((f) => f.id) ?? []) : [];

  return (
    <form action={action} className="space-y-6">
      {notice && <Alert variant="info" title={notice} message="" />}
      {state.error && <Alert variant="error" title={te.has(state.error) ? te(state.error) : state.error} message="" />}

      {userForm && (
        <section className="rounded-2xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-white/3">
          <h2 className="mb-4 text-base font-medium text-gray-800 dark:text-white/90">{userForm.title || t("contact")}</h2>
          <DynamicForm form={userForm} values={vals} errors={dynErrors} hidden={hidden} />
        </section>
      )}

      <section className="rounded-2xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-white/3">
        <h2 className="mb-4 text-base font-medium text-gray-800 dark:text-white/90">{t("preferences")}</h2>
        <div className="grid gap-5 sm:grid-cols-2">
          <FieldShell htmlFor="timezone" label={t("timezone")} errors={fieldErr("timezone")}>
            <select ref={tzRef} id="timezone" name="timezone" defaultValue={state.values?.timezone ?? timezone} className={selectCls}>
              <option value="">{t("timezoneDefault")}</option>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </FieldShell>
          {mode === "profile" && languages.length > 0 && (
            <FieldShell htmlFor="lang" label={t("language")}>
              <select id="lang" name="lang" defaultValue={state.values?.lang ?? lang ?? ""} className={selectCls}>
                <option value="">{t("languageBrowser")}</option>
                {languages.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </select>
            </FieldShell>
          )}
        </div>
      </section>

      {showPassword && (
        <section className="rounded-2xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-white/3">
          <h2 className="mb-4 text-base font-medium text-gray-800 dark:text-white/90">{t("credentials")}</h2>
          <div className="grid gap-5 sm:grid-cols-3">
            {requireCurrent && (
              <FieldShell htmlFor="cpasswd" label={t("currentPassword")} errors={fieldErr("cpasswd")}>
                <input id="cpasswd" name="cpasswd" type="password" maxLength={128} autoComplete="current-password" className={inputCls} />
              </FieldShell>
            )}
            <FieldShell htmlFor="passwd1" label={mode === "register" ? t("createPassword") : t("newPassword")} required={mode === "register"} errors={fieldErr("passwd1")}>
              <input id="passwd1" name="passwd1" type="password" maxLength={128} autoComplete="new-password" className={inputCls} />
            </FieldShell>
            <FieldShell htmlFor="passwd2" label={t("confirmPassword")} required={mode === "register"} errors={fieldErr("passwd2")}>
              <input id="passwd2" name="passwd2" type="password" maxLength={128} autoComplete="new-password" className={inputCls} />
            </FieldShell>
          </div>
        </section>
      )}

      <div className="flex flex-wrap justify-end gap-3">
        <Link href="/" className="h-11 rounded-lg border border-gray-300 px-5 text-sm leading-11 font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-white/5">
          {t("cancel")}
        </Link>
        <button type="submit" disabled={pending} className="h-11 rounded-lg bg-brand-500 px-6 text-sm font-medium text-white shadow-theme-xs hover:bg-brand-600 disabled:opacity-60">
          {pending ? t("saving") : mode === "register" ? t("register") : t("update")}
        </button>
      </div>
    </form>
  );
}
