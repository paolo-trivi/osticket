"use client";

import { useState } from "react";

import { cn } from "@/utils";

import FieldShell from "./FieldShell";
import { errorInputCls, inputCls } from "./styles";
import type { FieldInputProps } from "./types";

/** "2026-03-15T14:30" (ora locale del browser) → ISO con offset esplicito, letto correttamente dal server */
export function localToIsoWithOffset(local: string): string {
  if (!local) return "";
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return local;
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  return `${local.length === 16 ? `${local}:00` : local}${sign}${pad(off / 60)}:${pad(off % 60)}`;
}

/**
 * DatetimeField: data (come digitata, il PHP la interpreta nel fuso predefinito) oppure data e ora
 * (inviata con l'offset del browser).
 */
export default function DatetimeFieldInput({ field, value, errors }: FieldInputProps) {
  const id = `fld-${field.id}`;
  const initial = (value?.[0] ?? "").slice(0, field.config.time ? 16 : 10);
  const [local, setLocal] = useState(initial);
  return (
    <FieldShell htmlFor={id} label={field.label} hint={field.hint} required={field.required} errors={errors}>
      <input
        id={id}
        type={field.config.time ? "datetime-local" : "date"}
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        required={field.required}
        className={cn(inputCls, errors?.length && errorInputCls)}
      />
      <input type="hidden" name={field.key} value={field.config.time ? localToIsoWithOffset(local) : local} />
    </FieldShell>
  );
}
