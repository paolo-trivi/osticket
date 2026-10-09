"use client";

import { cn } from "@/utils";

import FieldShell from "./FieldShell";
import { errorInputCls, inputCls } from "./styles";
import type { FieldInputProps } from "./types";

/** TextboxField: testo su una riga */
export default function TextFieldInput({ field, value, errors }: FieldInputProps) {
  const id = `fld-${field.id}`;
  return (
    <FieldShell htmlFor={id} label={field.label} hint={field.hint} required={field.required} errors={errors}>
      <input
        id={id}
        name={field.key}
        type={field.name === "email" ? "email" : "text"}
        defaultValue={value?.[0] ?? field.config.defaultValue ?? ""}
        placeholder={field.config.placeholder}
        maxLength={field.config.maxLength}
        required={field.required}
        className={cn(inputCls, errors?.length && errorInputCls)}
      />
    </FieldShell>
  );
}
