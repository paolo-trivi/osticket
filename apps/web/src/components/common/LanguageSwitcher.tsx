"use client";

import { useLocale, useTranslations } from "next-intl";

import { languages } from "@/i18n/languages";
import { usePathname } from "@/i18n/navigation";
import type { Locale } from "@/i18n/routing";
import { withBase } from "@/lib/base-path";
import { cn } from "@/utils";

/**
 * Cambio lingua (pannello agenti e portale). Con localePrefix "never" la lingua sta nel cookie NEXT_LOCALE:
 * il router di next-intl passerebbe da /<lingua>/… e, poiché proxy.ts lascia passare i percorsi che
 * contengono già la lingua, il prefisso resterebbe nella barra degli indirizzi (e la query andrebbe persa).
 * Qui si scrive il cookie (come syncLocaleCookie di next-intl) e si ricarica lo stesso URL senza prefisso,
 * con query e frammento.
 */
/** Cookie della lingua (percorso: basePath oppure "/", come next-intl) e ricarica dello stesso URL. */
function reloadInLocale(next: Locale, pathname: string): void {
  const cookiePath = withBase("/").replace(/(.)\/$/, "$1");
  document.cookie = `NEXT_LOCALE=${next}; path=${cookiePath}; SameSite=Lax`;
  const { search, hash } = window.location;
  // ricarica completa voluta: cambiano lingua e direzione del documento (layout principale)
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.href = `${withBase(pathname)}${search}${hash}`;
}

export default function LanguageSwitcher({ className }: { className?: string }) {
  const t = useTranslations("header");
  const locale = useLocale() as Locale;
  const pathname = usePathname();

  const switchTo = (next: Locale) => {
    if (next !== locale) reloadInLocale(next, pathname);
  };

  return (
    <div role="group" aria-label={t("language")} className={cn("flex gap-2", className)}>
      {languages.map(({ id, name, shortName, FlagIcon }) => (
        <button
          key={id}
          type="button"
          lang={id}
          aria-label={name}
          aria-pressed={id === locale}
          onClick={() => switchTo(id)}
          className={cn(
            "flex items-center gap-1 rounded-md border px-2 py-1 text-theme-xs",
            id === locale
              ? "border-brand-300 text-brand-600 dark:border-brand-700 dark:text-brand-400"
              : "border-gray-200 text-gray-600 dark:border-gray-800 dark:text-gray-400",
          )}
        >
          <FlagIcon aria-hidden="true" className="size-4" />
          {shortName}
        </button>
      ))}
    </div>
  );
}
