"use client";

import { useTranslations } from "next-intl";
import { useEffect } from "react";

import { Link } from "@/i18n/navigation";
import { cn } from "@/utils";

/**
 * Contenuto delle pagine di errore (error.tsx dei pannelli e del portale): messaggio localizzato,
 * "Riprova" (retry di Next: ricarica e ridisegna il segmento) e ritorno alla home dell'area. In
 * produzione il messaggio dell'errore non arriva al browser: si mostra solo il codice (digest) da cercare
 * nei log del server.
 */
export default function ErrorState({
  error,
  retry,
  homeHref,
  fullPage = false,
}: {
  error: Error & { digest?: string };
  retry: () => void;
  homeHref: string;
  /** senza il guscio dell'area (errore nel layout): centrato nella finestra */
  fullPage?: boolean;
}) {
  const t = useTranslations("errorPage");

  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div role="alert" className={cn("flex flex-col items-center justify-center p-6 text-center", fullPage ? "min-h-screen" : "min-h-[50vh]")}>
      <h1 className="text-title-sm font-bold text-gray-800 dark:text-white/90">{t("title")}</h1>
      <p className="mt-4 max-w-md text-theme-sm text-gray-600 dark:text-gray-400">{t("message")}</p>
      {error.digest && <p className="mt-2 font-mono text-theme-xs text-gray-500 dark:text-gray-400">{t("code", { code: error.digest })}</p>}
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <button
          type="button"
          onClick={() => retry()}
          className="inline-flex items-center justify-center rounded-lg bg-brand-500 px-5 py-3 text-sm font-medium text-white shadow-theme-xs hover:bg-brand-600"
        >
          {t("retry")}
        </button>
        <Link
          href={homeHref}
          className="inline-flex items-center justify-center rounded-lg border border-gray-300 bg-white px-5 py-3 text-sm font-medium text-gray-700 shadow-theme-xs hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-white/3"
        >
          {t("backHome")}
        </Link>
      </div>
    </div>
  );
}
