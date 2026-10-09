"use client";

import { useState } from "react";

import { cn } from "@/utils";

import { controlClass, type Opt } from "./fields";

interface RepeaterColumn {
  key: string;
  label: string;
  kind: "text" | "number" | "select" | "checkbox" | "static";
  options?: Opt[];
  className?: string;
  placeholder?: string;
}

interface RepeaterRow {
  /** nomi del POST per colonna (righe esistenti) */
  names: Record<string, string>;
  values: Record<string, string | boolean>;
  /** colonne non modificabili (maschere di osTicket) */
  locked?: Record<string, boolean>;
  key: string;
}

/**
 * Tabella con righe esistenti (nomi del POST fissi, es. `label-<id>`) e righe nuove numerate in
 * modo contiguo (`newNames` con il segnaposto `{i}`, es. `label-new-{i}`), come i form di osTicket
 * che leggono le righe nuove finché esiste `sort-new-<i>`.
 */
export default function Repeater({
  columns,
  rows,
  newNames,
  initialNew = [],
  addLabel,
  removeLabel,
  emptyLabel,
  newDefaults = {},
}: {
  columns: RepeaterColumn[];
  rows: RepeaterRow[];
  newNames: Record<string, string>;
  initialNew?: Record<string, string | boolean>[];
  addLabel: string;
  removeLabel: string;
  emptyLabel?: string;
  newDefaults?: Record<string, string | boolean>;
}) {
  const [extra, setExtra] = useState<{ key: number; values: Record<string, string | boolean> }[]>(() => initialNew.map((values, i) => ({ key: i, values })));
  const [seq, setSeq] = useState(initialNew.length);

  const cell = (c: RepeaterColumn, name: string, value: string | boolean | undefined, locked?: boolean) => {
    if (c.kind === "static") return <span className="text-theme-xs text-gray-500 dark:text-gray-400">{String(value ?? "")}</span>;
    if (c.kind === "checkbox")
      return <input type="checkbox" name={name} value="on" defaultChecked={!!value} disabled={locked} aria-label={c.label} className="h-4 w-4 accent-brand-500" />;
    if (c.kind === "select")
      return (
        <select name={locked ? undefined : name} defaultValue={String(value ?? "")} disabled={locked} aria-label={c.label} className={cn(controlClass, "h-10 py-0")}>
          {(c.options ?? []).map((o) => (
            <option key={o.value} value={o.value} disabled={o.disabled} className="dark:bg-gray-900">
              {o.label}
            </option>
          ))}
        </select>
      );
    return (
      <input
        name={locked ? undefined : name}
        type={c.kind === "number" ? "number" : "text"}
        defaultValue={String(value ?? "")}
        readOnly={locked}
        placeholder={c.placeholder}
        aria-label={c.label}
        className={cn(controlClass, "h-10", locked && "bg-gray-50 dark:bg-white/3")}
      />
    );
  };

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-gray-800">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 dark:border-gray-800">
              {columns.map((c) => (
                <th key={c.key} className={cn("px-3 py-2 text-start text-theme-xs font-medium text-gray-500 uppercase dark:text-gray-400", c.className)}>
                  {c.label}
                </th>
              ))}
              <th className="w-10" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
            {rows.length + extra.length === 0 && emptyLabel && (
              <tr>
                <td colSpan={columns.length + 1} className="px-3 py-6 text-center text-gray-500 dark:text-gray-400">
                  {emptyLabel}
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.key}>
                {columns.map((c) => (
                  <td key={c.key} className={cn("px-3 py-2", c.className)}>
                    {r.names[c.key] || c.kind === "static" ? (
                      cell(c, r.names[c.key] ?? "", r.values[c.key], r.locked?.[c.key])
                    ) : typeof r.values[c.key] === "string" && r.values[c.key] ? (
                      <span className="text-theme-xs text-gray-500 dark:text-gray-400">{String(r.values[c.key])}</span>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                ))}
                <td />
              </tr>
            ))}
            {extra.map((row, idx) => (
              <tr key={`new-${row.key}`}>
                {columns.map((c) => (
                  <td key={c.key} className={cn("px-3 py-2", c.className)}>
                    {newNames[c.key] ? cell(c, newNames[c.key].replaceAll("{i}", String(idx)), row.values[c.key]) : null}
                  </td>
                ))}
                <td className="px-2">
                  <button
                    type="button"
                    onClick={() => setExtra((x) => x.filter((y) => y.key !== row.key))}
                    className="rounded px-2 py-1 text-error-600 hover:bg-error-50 dark:text-error-400 dark:hover:bg-error-500/10"
                    aria-label={removeLabel}
                    title={removeLabel}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button
        type="button"
        onClick={() => {
          setExtra((x) => [...x, { key: seq, values: { ...newDefaults } }]);
          setSeq((s) => s + 1);
        }}
        className="rounded-lg px-3 py-2 text-sm font-medium text-brand-600 ring-1 ring-brand-300 ring-inset hover:bg-brand-50 dark:text-brand-400 dark:ring-brand-500/40 dark:hover:bg-brand-500/10"
      >
        + {addLabel}
      </button>
    </div>
  );
}
