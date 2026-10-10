"use client";

import ErrorState from "@/components/common/ErrorState";

/**
 * Errore nei layout delle aree (guscio agenti/admin, portale) o nelle pagine fuori dai gruppi (login):
 * pagina intera, ancora con tema, lingua e provider del layout principale.
 */
export default function LocaleError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <main className="bg-white dark:bg-gray-900">
      <ErrorState error={error} retry={retry} homeHref="/" fullPage />
    </main>
  );
}
