"use client";

import type { ReactNode } from "react";

import { ChevronDown } from "lucide-react";

import type { Choice } from "./types";

/** Select nativa con nome (inviata nel FormData), stile TailAdmin. */
export function FieldSelect({
  name,
  label,
  options,
  placeholder,
  defaultValue = "",
  groups,
  onChange,
}: {
  name: string;
  label?: string;
  options?: { value: string; label: string }[];
  groups?: { label: string; options: { value: string; label: string }[] }[];
  placeholder?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
}) {
  const optionClass = "text-gray-700 dark:bg-gray-900 dark:text-gray-400";
  return (
    <label className="block space-y-1.5">
      {label && <span className="text-theme-sm font-medium text-gray-700 dark:text-gray-400">{label}</span>}
      <span className="relative block">
        <select
          name={name}
          defaultValue={defaultValue}
          required
          onChange={(e) => onChange?.(e.target.value)}
          className="h-11 w-full appearance-none rounded-lg border border-gray-300 bg-transparent px-4 py-2.5 pe-11 text-sm text-gray-800 shadow-theme-xs focus:border-brand-300 focus:ring-3 focus:ring-brand-500/10 focus:outline-hidden dark:border-gray-700 dark:bg-gray-900 dark:text-white/90 dark:focus:border-brand-800"
        >
          {placeholder !== undefined && (
            <option value="" disabled className={optionClass}>
              {placeholder}
            </option>
          )}
          {options?.map((o) => (
            <option key={o.value} value={o.value} className={optionClass}>
              {o.label}
            </option>
          ))}
          {groups?.map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.options.map((o) => (
                <option key={o.value} value={o.value} className={optionClass}>
                  {o.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <span className="pointer-events-none absolute inset-e-3 top-1/2 -translate-y-1/2 text-gray-500 dark:text-gray-400">
          <ChevronDown className="size-5" />
        </span>
      </span>
    </label>
  );
}

/** Checkbox nativa con nome e valore (predefinito "1"). */
export function FieldCheck({ name, label, value = "1", defaultChecked = false }: { name: string; label: ReactNode; value?: string; defaultChecked?: boolean }) {
  return (
    <label className="flex cursor-pointer items-center gap-3 text-theme-sm text-gray-700 dark:text-gray-400">
      <input
        type="checkbox"
        name={name}
        value={value}
        defaultChecked={defaultChecked}
        className="size-4 rounded border-gray-300 text-brand-500 focus:ring-brand-500/20 dark:border-gray-700 dark:bg-gray-900"
      />
      <span>{label}</span>
    </label>
  );
}

export const toOptions = (list: Choice[], prefix = "") => list.map((c) => ({ value: `${prefix}${c.id}`, label: c.name }));
