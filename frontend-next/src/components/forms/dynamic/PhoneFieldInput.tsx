"use client";

import { useTranslations } from "next-intl";

import { cn } from "@/utils";

import FieldShell from "./FieldShell";
import { errorInputCls, inputCls } from "./styles";
import type { FieldInputProps } from "./types";

/** PhoneField: numero ed eventuale interno */
export default function PhoneFieldInput({ field, value, errors }: FieldInputProps) {
  const t = useTranslations("dynamicForms");
  const id = `fld-${field.id}`;
  return (
    <FieldShell htmlFor={id} label={field.label} hint={field.hint} required={field.required} errors={errors}>
      <div className="flex gap-3">
        <input id={id} name={field.key} type="tel" defaultValue={value?.[0] ?? ""} required={field.required} className={cn(inputCls, errors?.length && errorInputCls)} />
        {field.config.ext && (
          <input name={`${field.key}-ext`} type="text" inputMode="numeric" placeholder={t("ext")} aria-label={t("ext")} className={cn(inputCls, "max-w-28")} />
        )}
      </div>
    </FieldShell>
  );
}
