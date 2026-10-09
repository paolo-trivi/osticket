"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { ChevronDownIcon } from "@/icons";
import { cn } from "@/utils";

import type { Choice, DynField } from "./types";

const inputClass =
  "h-11 w-full rounded-lg border border-gray-300 bg-transparent px-4 py-2.5 text-sm text-gray-800 shadow-theme-xs placeholder:text-gray-400 focus:border-brand-300 focus:ring-3 focus:ring-brand-500/10 focus:outline-hidden dark:border-gray-700 dark:bg-gray-900 dark:text-white/90 dark:placeholder:text-white/30 dark:focus:border-brand-800";

/** Messaggio d'errore di un campo (codici di peopleUi.fieldErrors). */
export function FieldError({ code }: { code?: string }) {
  const t = useTranslations("peopleUi");
  if (!code) return null;
  return <p className="mt-1.5 text-theme-xs text-error-500">{t.has(`fieldErrors.${code}`) ? t(`fieldErrors.${code}`) : code}</p>;
}

function Wrap({ label, required, error, hint, children }: { label?: ReactNode; required?: boolean; error?: string; hint?: string | null; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      {label && (
        <span className="text-theme-sm font-medium text-gray-700 dark:text-gray-400">
          {label}
          {required && <span className="ms-0.5 text-error-500">*</span>}
        </span>
      )}
      {children}
      {hint && !error && <span className="block text-theme-xs text-gray-500 dark:text-gray-400">{hint}</span>}
      <FieldError code={error} />
    </label>
  );
}

export function TextField({
  name,
  label,
  defaultValue,
  type = "text",
  required,
  error,
  hint,
  placeholder,
  autoComplete,
  maxLength,
}: {
  name: string;
  label?: ReactNode;
  defaultValue?: string | number | null;
  type?: string;
  required?: boolean;
  error?: string;
  hint?: string | null;
  placeholder?: string;
  autoComplete?: string;
  maxLength?: number;
}) {
  return (
    <Wrap label={label} required={required} error={error} hint={hint}>
      <input
        name={name}
        type={type}
        defaultValue={defaultValue ?? ""}
        placeholder={placeholder}
        autoComplete={autoComplete}
        maxLength={maxLength}
        className={cn(inputClass, error && "border-error-500 dark:border-error-500")}
      />
    </Wrap>
  );
}

export function TextAreaField({ name, label, defaultValue, rows = 4, error, hint, required }: { name: string; label?: ReactNode; defaultValue?: string | null; rows?: number; error?: string; hint?: string | null; required?: boolean }) {
  return (
    <Wrap label={label} required={required} error={error} hint={hint}>
      <textarea
        name={name}
        rows={rows}
        defaultValue={defaultValue ?? ""}
        className={cn(inputClass, "h-auto", error && "border-error-500 dark:border-error-500")}
      />
    </Wrap>
  );
}

export function SelectField({
  name,
  label,
  options,
  defaultValue = "",
  placeholder,
  error,
  onChange,
  required,
}: {
  name: string;
  label?: ReactNode;
  options: Choice[];
  defaultValue?: string | number;
  placeholder?: string;
  error?: string;
  onChange?: (value: string) => void;
  required?: boolean;
}) {
  const optionClass = "text-gray-700 dark:bg-gray-900 dark:text-gray-400";
  return (
    <Wrap label={label} error={error} required={required}>
      <span className="relative block">
        <select
          name={name}
          defaultValue={String(defaultValue)}
          onChange={(e) => onChange?.(e.target.value)}
          className={cn(inputClass, "appearance-none pe-11")}
        >
          {placeholder !== undefined && (
            <option value="" className={optionClass}>
              {placeholder}
            </option>
          )}
          {options.map((o) => (
            <option key={o.id} value={String(o.id)} className={optionClass}>
              {o.name}
            </option>
          ))}
        </select>
        <span className="pointer-events-none absolute inset-e-3 top-1/2 -translate-y-1/2 text-gray-500 dark:text-gray-400">
          <ChevronDownIcon />
        </span>
      </span>
    </Wrap>
  );
}

export function CheckField({ name, label, defaultChecked = false, value = "1" }: { name: string; label: ReactNode; defaultChecked?: boolean; value?: string }) {
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

/** Campo di un form dinamico (DynamicFormField) con il nome del campo come chiave del FormData. */
export function DynamicField({ field, error }: { field: DynField; error?: string }) {
  const key = field.name || String(field.id);
  switch (field.type) {
    case "memo":
      return <TextAreaField name={key} label={field.label} defaultValue={field.value} required={field.required} error={error} hint={field.hint} />;
    case "bool":
      return <CheckField name={key} label={field.label} defaultChecked={field.value === "1"} />;
    case "choices":
      return (
        <SelectField
          name={key}
          label={field.label}
          defaultValue={field.value}
          placeholder="—"
          required={field.required}
          error={error}
          options={Object.entries(field.choices ?? {}).map(([id, name]) => ({ id, name }))}
        />
      );
    case "datetime":
      return <TextField name={key} type="datetime-local" label={field.label} defaultValue={field.value} required={field.required} error={error} hint={field.hint} />;
    case "phone":
      return <TextField name={key} type="tel" label={field.label} defaultValue={field.value} required={field.required} error={error} hint={field.hint} />;
    default:
      return <TextField name={key} type={field.name === "email" ? "email" : "text"} label={field.label} defaultValue={field.value} required={field.required} error={error} hint={field.hint} />;
  }
}

/** Notifica di esito/errore in cima ai form. */
export function FormAlert({ kind, children }: { kind: "error" | "success" | "info" | "warning"; children: ReactNode }) {
  const cls = {
    error: "bg-error-50 text-error-600 dark:bg-error-500/15 dark:text-error-400",
    success: "bg-success-50 text-success-700 dark:bg-success-500/15 dark:text-success-400",
    info: "bg-blue-light-50 text-blue-light-700 dark:bg-blue-light-500/15 dark:text-blue-light-400",
    warning: "bg-warning-50 text-warning-700 dark:bg-warning-500/15 dark:text-warning-400",
  }[kind];
  return <div className={cn("rounded-lg px-4 py-3 text-theme-sm", cls)}>{children}</div>;
}
