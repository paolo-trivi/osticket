"use client";

import Label from "@/components/form/Label";
import type { ThemeSettings } from "@/lib/theme/schema";
import { cn } from "@/utils";
import type { ReactNode } from "react";

/** Aggiorna un'impostazione del tema in modifica. */
export type SetThemeField = <K extends keyof ThemeSettings>(key: K, value: ThemeSettings[K]) => void;

/** Scelta tra poche opzioni a pulsanti affiancati (gruppo con nome, pulsante scelto con aria-pressed). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  /** nome accessibile del gruppo (di solito l'etichetta del campo) */
  label?: string;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex flex-wrap gap-1 rounded-lg bg-gray-100 p-1 dark:bg-gray-900">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-md px-3 py-1.5 text-theme-sm font-medium transition",
            value === o.value
              ? "bg-white text-gray-900 shadow-theme-xs dark:bg-gray-800 dark:text-white"
              : "text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Campo con etichetta (collegata al controllo con `htmlFor`) e nota facoltativa. */
export function Field({ label, hint, htmlFor, children }: { label: string; hint?: string; htmlFor?: string; children: ReactNode }) {
  const hintId = htmlFor && hint ? `${htmlFor}-hint` : undefined;
  return (
    <div>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && (
        <p id={hintId} className="mt-1.5 text-theme-xs text-gray-500 dark:text-gray-400">
          {hint}
        </p>
      )}
    </div>
  );
}
