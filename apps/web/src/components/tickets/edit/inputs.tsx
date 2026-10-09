"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import RichTextEditor from "@/components/editor/RichTextEditor";
import { inputCls, selectCls } from "@/components/forms/dynamic/styles";

/** Etichetta + controllo (stile TailAdmin). */
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-theme-sm font-medium text-gray-700 dark:text-gray-400">{label}</span>
      {children}
      {hint && <span className="block text-theme-xs text-gray-500 dark:text-gray-400">{hint}</span>}
    </label>
  );
}

/** Select nativa con nome, opzioni e voce vuota facoltativa. */
export function Select({
  name,
  options,
  defaultValue,
  empty,
  required,
  value,
  onChange,
}: {
  name?: string;
  options: { value: string; label: string }[];
  defaultValue?: string;
  empty?: string;
  required?: boolean;
  value?: string;
  onChange?: (v: string) => void;
}) {
  return (
    <select
      name={name}
      defaultValue={value === undefined ? defaultValue : undefined}
      value={value}
      required={required}
      onChange={(e) => onChange?.(e.target.value)}
      className={selectCls}
    >
      {empty !== undefined && <option value="">{empty}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value} className="dark:bg-gray-900">
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={inputCls} />;
}

/** Casella di spunta con valore "1". */
export function Check({ name, label, defaultChecked, value = "1" }: { name: string; label: ReactNode; defaultChecked?: boolean; value?: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-3 text-theme-sm text-gray-700 dark:text-gray-400">
      <input type="checkbox" name={name} value={value} defaultChecked={defaultChecked} className="size-4 rounded border-gray-300 accent-brand-500 dark:border-gray-700" />
      <span>{label}</span>
    </label>
  );
}

/** Editor HTML con le etichette del composer. */
export function Editor({ name, placeholder, defaultValue, minHeight = 90 }: { name: string; placeholder?: string; defaultValue?: string; minHeight?: number }) {
  const tc = useTranslations("composer");
  return (
    <RichTextEditor
      name={name}
      placeholder={placeholder}
      defaultValue={defaultValue}
      minHeight={minHeight}
      labels={{
        bold: tc("editor.bold"),
        italic: tc("editor.italic"),
        underline: tc("editor.underline"),
        bullets: tc("editor.bullets"),
        numbers: tc("editor.numbers"),
        link: tc("editor.link"),
        quote: tc("editor.quote"),
        linkPrompt: tc("editor.linkPrompt"),
      }}
    />
  );
}
