import type { ReactNode } from "react";

interface PeopleCard {
  key: string | number;
  /** casella di selezione per le azioni di massa (stesso valore della riga della tabella) */
  select?: ReactNode;
  title: ReactNode;
  /** stato accanto al titolo */
  badge?: ReactNode;
  meta: { label: string; value: ReactNode }[];
}

/**
 * Lista su mobile delle pagine people (utenti, organizzazioni, task), al posto della tabella sotto md
 * come la lista ticket: una scheda per riga, titolo in testa e le altre colonne in griglia a due
 * colonne con l'etichetta sopra il valore.
 */
export default function PeopleCards({ cards, empty }: { cards: PeopleCard[]; empty: string }) {
  return (
    <ul className="space-y-3 md:hidden">
      {cards.length === 0 && (
        <li className="rounded-2xl border border-gray-200 bg-white px-4 py-8 text-center text-sm text-gray-500 dark:border-gray-800 dark:bg-white/3 dark:text-gray-400">{empty}</li>
      )}
      {cards.map((c) => (
        <li key={c.key} className="flex gap-3 rounded-2xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-white/3">
          {c.select && <span className="mt-0.5 shrink-0">{c.select}</span>}
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-sm font-semibold break-words text-gray-800 dark:text-white/90">
              {c.title}
              {c.badge}
            </div>
            {c.meta.length > 0 && (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                {c.meta.map((m) => (
                  <div key={m.label} className="min-w-0">
                    <dt className="truncate text-theme-xs text-gray-500 dark:text-gray-400">{m.label}</dt>
                    <dd className="min-w-0 break-words text-gray-700 dark:text-gray-300">{m.value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
