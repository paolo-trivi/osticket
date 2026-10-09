"use client";

import { useActionState } from "react";

import { useTranslations } from "next-intl";

import Label from "@/components/form/Label";
import Input from "@/components/form/input/InputField";
import Alert from "@/components/ui/alert/Alert";
import { Link } from "@/i18n/navigation";

import { accessLinkAction, portalLoginAction, type AccessLinkState, type PortalLoginState } from "@/app/[locale]/(client)/actions";

interface Props {
  next?: string;
  /** errore arrivato dal link (view, conferma) */
  linkError?: string;
  /** login con account disponibile (client_registration != disabled) */
  showLogin: boolean;
  canRegister: boolean;
  /** con client_verify_email il link arriva via email, altrimenti accesso diretto */
  verifyEmail: boolean;
  canOpen: boolean;
  allowReset: boolean;
  defaults: { login?: string; email?: string; number?: string };
  banner: { title: string; html: string } | null;
}

const BTN = "h-11 w-full rounded-lg bg-brand-500 px-5 text-sm font-medium text-white shadow-theme-xs hover:bg-brand-600 disabled:opacity-60";

/** login.php: accesso con account (login.inc.php) e verifica dello stato con numero del ticket (accesslink.inc.php). */
export default function LoginPanel({ next, linkError, showLogin, canRegister, verifyEmail, canOpen, allowReset, defaults, banner }: Props) {
  const t = useTranslations("portal.login");
  const te = useTranslations("portal.errors");
  const [login, loginAction, loginPending] = useActionState<PortalLoginState, FormData>(portalLoginAction, {});
  const [link, linkAction, linkPending] = useActionState<AccessLinkState, FormData>(accessLinkAction, {});
  const err = (code?: string) => (code ? (te.has(code) ? te(code) : code) : null);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {showLogin && (
        <section className="rounded-2xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-white/3">
          <h1 className="text-title-sm font-semibold text-gray-800 dark:text-white/90">{banner?.title || t("title")}</h1>
          {banner ? (
            <div className="mt-2 text-sm text-gray-500 dark:text-gray-400" dangerouslySetInnerHTML={{ __html: banner.html }} />
          ) : (
            <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">{t("subtitle")}</p>
          )}
          {login.error && (
            <div className="mt-4">
              <Alert variant="error" title={err(login.error)!} message="" />
            </div>
          )}
          <form action={loginAction} className="mt-5 space-y-5">
            <input type="hidden" name="next" value={next ?? ""} />
            <div>
              <Label htmlFor="login">{t("login")}</Label>
              <Input id="login" name="login" autoComplete="username" defaultValue={login.login ?? defaults.login} required />
            </div>
            <div>
              <Label htmlFor="password">{t("password")}</Label>
              <Input id="password" name="password" type="password" autoComplete="current-password" maxLength={128} required />
            </div>
            <button type="submit" className={BTN} disabled={loginPending}>
              {loginPending ? t("signingIn") : t("signIn")}
            </button>
            <div className="flex flex-wrap justify-between gap-2 text-theme-sm">
              {allowReset && (
                <Link href="/pwreset" className="text-brand-600 hover:underline dark:text-brand-400">
                  {t("forgot")}
                </Link>
              )}
              {canRegister && (
                <span className="text-gray-500 dark:text-gray-400">
                  {t("notRegistered")}{" "}
                  <Link href="/account" className="text-brand-600 hover:underline dark:text-brand-400">
                    {t("createAccount")}
                  </Link>
                </span>
              )}
            </div>
            <p className="text-theme-xs text-gray-500 dark:text-gray-400">
              {t("agent")}{" "}
              <Link href="/agent/login" className="text-brand-600 hover:underline dark:text-brand-400">
                {t("agentLink")}
              </Link>
            </p>
          </form>
        </section>
      )}

      <section id="access" className="rounded-2xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-white/3">
        <h2 className="text-title-sm font-semibold text-gray-800 dark:text-white/90">{t("accessTitle")}</h2>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">{verifyEmail ? t("accessVerify") : t("accessDirect")}</p>
        {(link.error || linkError) && (
          <div className="mt-4">
            <Alert variant="error" title={err(link.error ?? linkError)!} message="" />
          </div>
        )}
        {link.sent && (
          <div className="mt-4">
            <Alert variant="success" title={t("linkSent")} message="" />
          </div>
        )}
        <form action={linkAction} className="mt-5 space-y-5">
          <div>
            <Label htmlFor="email">{t("email")}</Label>
            <Input id="email" name="email" type="email" placeholder={t("emailPlaceholder")} defaultValue={link.email ?? defaults.email} required />
          </div>
          <div>
            <Label htmlFor="number">{t("number")}</Label>
            <Input id="number" name="number" placeholder={t("numberPlaceholder")} defaultValue={link.number ?? defaults.number} required />
          </div>
          <button type="submit" className={BTN} disabled={linkPending}>
            {verifyEmail ? t("sendLink") : t("viewTicket")}
          </button>
        </form>
        {canOpen && (
          <p className="mt-5 text-theme-sm text-gray-500 dark:text-gray-400">
            {t("firstTime")}{" "}
            <Link href="/open" className="text-brand-600 hover:underline dark:text-brand-400">
              {t("openNew")}
            </Link>
          </p>
        )}
      </section>
    </div>
  );
}
