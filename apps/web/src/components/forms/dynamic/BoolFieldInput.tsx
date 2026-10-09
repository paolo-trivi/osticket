"use client";

import FieldShell from "./FieldShell";
import type { FieldInputProps } from "./types";

/** BooleanField: casella di spunta (il marcatore `:present` distingue "non spuntata" da "assente") */
export default function BoolFieldInput({ field, value, errors }: FieldInputProps) {
  const id = `fld-${field.id}`;
  return (
    <FieldShell label={field.label} hint={field.hint} required={field.required} errors={errors}>
      <input type="hidden" name={`${field.key}:present`} value="1" />
      <label htmlFor={id} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-400">
        <input id={id} type="checkbox" name={field.key} value="1" defaultChecked={value?.[0] === "1"} className="size-4 accent-brand-500" />
        {field.config.desc}
      </label>
    </FieldShell>
  );
}
