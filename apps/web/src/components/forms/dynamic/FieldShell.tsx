"use client";

import type { ReactNode } from "react";

import { cn } from "@/utils";

interface Props {
  htmlFor?: string;
  label: string;
  hint?: string;
  required?: boolean;
  errors?: string[];
  className?: string;
  children: ReactNode;
}

/** Etichetta, suggerimento ed errori di un campo dei form dinamici. */
export default function FieldShell({ htmlFor, label, hint, required, errors, className, children }: Props) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && (
        <label htmlFor={htmlFor} className="text-sm font-medium text-gray-700 dark:text-gray-400">
          {label}
          {required && <span className="ms-0.5 text-error-500">*</span>}
        </label>
      )}
      {children}
      {hint && <p className="text-theme-xs text-gray-500 dark:text-gray-400">{hint}</p>}
      {errors?.map((e) => (
        <p key={e} role="alert" className="text-theme-xs text-error-600 dark:text-error-400">
          {e}
        </p>
      ))}
    </div>
  );
}
