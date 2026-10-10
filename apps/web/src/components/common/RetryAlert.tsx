"use client";

/** Errore recuperabile dentro un modulo (es. caricamento dei campi di un argomento fallito) con "Riprova". */
export default function RetryAlert({ message, retryLabel, onRetry }: { message: string; retryLabel: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg bg-error-50 px-4 py-3 text-theme-sm text-error-700 dark:bg-error-500/15 dark:text-error-400">
      <span>{message}</span>
      <button type="button" onClick={onRetry} className="font-medium underline hover:no-underline">
        {retryLabel}
      </button>
    </div>
  );
}
