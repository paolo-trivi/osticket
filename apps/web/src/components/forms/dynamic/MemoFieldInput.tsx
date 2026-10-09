"use client";

import { cn } from "@/utils";

import FieldShell from "./FieldShell";
import { errorInputCls, textareaCls } from "./styles";
import type { FieldInputProps } from "./types";

/** TextareaField: testo lungo (l'HTML eventuale è sanificato dal server) */
export default function MemoFieldInput({ field, value, errors }: FieldInputProps) {
  const id = `fld-${field.id}`;
  return (
    <FieldShell htmlFor={id} label={field.label} hint={field.hint} required={field.required} errors={errors}>
      <textarea
        id={id}
        name={field.key}
        rows={field.config.rows ?? 4}
        defaultValue={value?.[0] ?? ""}
        placeholder={field.config.placeholder}
        maxLength={field.config.maxLength}
        required={field.required}
        className={cn(textareaCls, errors?.length && errorInputCls)}
      />
    </FieldShell>
  );
}
