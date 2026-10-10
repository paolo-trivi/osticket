"use client";

import { useTranslations } from "next-intl";
import { createContext, useContext, useId, type ReactNode } from "react";

import RichTextEditor from "@/components/editor/RichTextEditor";
import { inputCls, selectCls } from "@/components/forms/dynamic/styles";

/** id del controllo e del suggerimento di un Field, letti da Select e TextInput */
const FieldIds = createContext<{ id: string; hintId?: string } | null>(null);

/**
 * Etichetta + controllo (stile TailAdmin). L'etichetta è collegata al controllo con htmlFor/id e il
 * suggerimento con aria-describedby (come people/FormControls): avvolgendo il controllo, il testo del
 * suggerimento finirebbe nel nome accessibile del campo.
 */
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-theme-sm font-medium text-gray-700 dark:text-gray-400">
        {label}
      </label>
      <FieldIds.Provider value={{ id, hintId }}>{children}</FieldIds.Provider>
      {hint && (
        <span id={hintId} className="block text-theme-xs text-gray-500 dark:text-gray-400">
          {hint}
        </span>
      )}
    </div>
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
  const ids = useContext(FieldIds);
  return (
    <select
      id={ids?.id}
      aria-describedby={ids?.hintId}
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
  const ids = useContext(FieldIds);
  return <input id={ids?.id} aria-describedby={ids?.hintId} {...props} className={inputCls} />;
}

/** Casella di spunta con valore "1". */
export function Check({
  name,
  label,
  defaultChecked,
  value = "1",
  onChange,
}: {
  name: string;
  label: ReactNode;
  defaultChecked?: boolean;
  value?: string;
  onChange?: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-3 text-theme-sm text-gray-700 dark:text-gray-400">
      <input
        type="checkbox"
        name={name}
        value={value}
        defaultChecked={defaultChecked}
        onChange={(e) => onChange?.(e.target.checked)}
        className="size-4 rounded border-gray-300 accent-brand-500 dark:border-gray-700"
      />
      <span>{label}</span>
    </label>
  );
}

/** Editor HTML con le etichette del composer; `label` è il nome accessibile (altrimenti il segnaposto). */
export function Editor({ name, placeholder, defaultValue, minHeight = 90, label }: { name: string; placeholder?: string; defaultValue?: string; minHeight?: number; label?: string }) {
  const tc = useTranslations("composer");
  return (
    <RichTextEditor
      name={name}
      placeholder={placeholder}
      label={label}
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
