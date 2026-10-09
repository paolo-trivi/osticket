import type { ReactNode } from "react";

import { Link } from "@/i18n/navigation";
import { cn } from "@/utils";

export interface DataColumn {
  key: string;
  label: string;
  /** link di ordinamento (se la colonna è ordinabile) */
  sortHref?: string;
  sorted?: "asc" | "desc";
  className?: string;
}

/** Tabella stile TailAdmin per le liste del pannello (server component). */
export default function DataTable({
  columns,
  rows,
  empty,
}: {
  columns: DataColumn[];
  rows: { key: string | number; cells: Record<string, ReactNode> }[];
  empty: string;
}) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-white/3">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="border-b border-gray-100 dark:border-gray-800">
            {columns.map((c) => (
              <th
                key={c.key}
                className={cn("px-4 py-3 text-start text-theme-xs font-medium whitespace-nowrap text-gray-500 uppercase dark:text-gray-400", c.className)}
              >
                {c.sortHref ? (
                  <Link href={c.sortHref} className="hover:text-gray-800 dark:hover:text-white">
                    {c.label}
                    {c.sorted === "asc" ? " ▲" : c.sorted === "desc" ? " ▼" : ""}
                  </Link>
                ) : (
                  c.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="px-4 py-10 text-center text-gray-500 dark:text-gray-400">
                {empty}
              </td>
            </tr>
          )}
          {rows.map((r) => (
            <tr key={r.key} className="hover:bg-gray-50 dark:hover:bg-white/2">
              {columns.map((c) => (
                <td key={c.key} className={cn("px-4 py-3 text-gray-700 dark:text-gray-300", c.className)}>
                  {r.cells[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-xl font-semibold text-gray-800 dark:text-white/90">{title}</h2>
        {subtitle && <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}

export function SearchBox({ action, name = "q", value, placeholder, hidden }: { action: string; name?: string; value?: string; placeholder: string; hidden?: Record<string, string> }) {
  return (
    <form action={action} className="flex gap-2">
      {Object.entries(hidden ?? {}).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <input
        type="search"
        name={name}
        defaultValue={value}
        placeholder={placeholder}
        className="h-10 w-64 rounded-lg border border-gray-200 bg-transparent px-3 text-sm text-gray-800 placeholder:text-gray-400 focus:border-brand-300 focus:outline-hidden dark:border-gray-800 dark:text-white/90"
      />
    </form>
  );
}

export function Forbidden({ message }: { message: string }) {
  return (
    <div className="rounded-2xl border border-error-200 bg-error-50 p-6 text-error-700 dark:border-error-500/30 dark:bg-error-500/10 dark:text-error-400">
      {message}
    </div>
  );
}
