"use client";

import { useTranslations } from "next-intl";

import { cn } from "@/utils";

import FieldShell from "./FieldShell";
import { errorInputCls, selectCls } from "./styles";
import type { FieldInputProps } from "./types";

/**
 * ChoiceField, SelectionField (liste), PriorityField, DepartmentField: menu a tendina, oppure caselle
 * di spunta se la scelta è multipla.
 */
export default function ChoiceFieldInput({ field, value, errors }: FieldInputProps) {
  const t = useTranslations("dynamicForms");
  const id = `fld-${field.id}`;
  const choices = field.choices ?? [];
  const selected = value ?? (field.config.defaultValue ? [field.config.defaultValue] : []);
  if (field.multiple) {
    return (
      <FieldShell label={field.label} hint={field.hint} required={field.required} errors={errors}>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {choices.map((c) => (
            <label key={c.value} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-400">
              <input type="checkbox" name={field.key} value={c.value} defaultChecked={selected.includes(c.value)} className="size-4 accent-brand-500" />
              {c.label}
            </label>
          ))}
        </div>
      </FieldShell>
    );
  }
  return (
    <FieldShell htmlFor={id} label={field.label} hint={field.hint} required={field.required} errors={errors}>
      <select id={id} name={field.key} defaultValue={selected[0] ?? ""} required={field.required} className={cn(selectCls, errors?.length && errorInputCls)}>
        <option value="">{field.config.prompt || t("select")}</option>
        {choices.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}
