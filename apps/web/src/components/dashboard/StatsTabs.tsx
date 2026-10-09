import type { ReactNode } from "react";

import { Link } from "@/i18n/navigation";
import { DownloadIcon } from "@/icons";
import { cn } from "@/utils";

export interface StatsTab {
  key: string;
  label: string;
  /** righe della tabella della scheda */
  count: number;
  /** testo accessibile del conteggio ("2 righe") */
  countLabel: string;
  href: string;
}

interface StatsTabsProps {
  tabs: StatsTab[];
  active: string;
  exportHref: string;
  exportLabel: string;
  exportTitle: string;
  /** tabella della scheda attiva */
  children: ReactNode;
}

/**
 * Schede Reparto / Argomento / Agente (ul.tabs di include/staff/dashboard.inc.php) con il numero di righe
 * e l'esportazione CSV della scheda attiva (stessi filtri della pagina).
 */
export default function StatsTabs({ tabs, active, exportHref, exportLabel, exportTitle, children }: StatsTabsProps) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <nav className="flex w-full flex-wrap gap-1 sm:w-auto sm:gap-2">
          {tabs.map((tab) => (
            <Link
              key={tab.key}
              href={tab.href}
              aria-current={tab.key === active ? "page" : undefined}
              className={cn(
                "inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium",
                tab.key === active
                  ? "bg-brand-50 text-brand-600 dark:bg-brand-500/15 dark:text-brand-400"
                  : "text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-white/5",
              )}
            >
              {tab.label}
              <span className="sr-only">({tab.countLabel})</span>
              <span
                aria-hidden="true"
                className={cn(
                  "rounded-full px-2 py-0.5 text-theme-xs tabular-nums",
                  tab.key === active ? "bg-brand-100 text-brand-700 dark:bg-brand-500/20 dark:text-brand-300" : "bg-gray-100 text-gray-500 dark:bg-white/5 dark:text-gray-400",
                )}
              >
                {tab.count}
              </span>
            </Link>
          ))}
        </nav>
        {/* file da scaricare: un <a> semplice (non è una navigazione dell'app) */}
        <a
          href={exportHref}
          download
          title={exportTitle}
          className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-gray-700 ring-1 ring-gray-300 ring-inset hover:bg-gray-50 dark:text-gray-300 dark:ring-gray-700 dark:hover:bg-white/5"
        >
          <DownloadIcon className="size-4" />
          {exportLabel}
        </a>
      </div>
      {children}
    </div>
  );
}
