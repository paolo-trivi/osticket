"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";

import ComponentCard from "@/components/common/ComponentCard";
import Label from "@/components/form/Label";
import Input from "@/components/form/input/InputField";
import Button from "@/components/ui/button/Button";
import { IDLE, type AdminFormState, type FormField, type FormSection } from "@/lib/admin/form-schema";
import { cn } from "@/utils";

import AccessEditor from "./AccessEditor";

const control =
  "w-full rounded-lg border border-gray-300 bg-transparent px-4 py-2.5 text-sm text-gray-800 shadow-theme-xs focus:border-brand-300 focus:ring-3 focus:ring-brand-500/10 focus:outline-hidden dark:border-gray-700 dark:bg-gray-900 dark:text-white/90";

/** Messaggio tradotto di un codice d'errore (adminUi.errors.<codice>, altrimenti il codice). */
function useErrorText() {
  const t = useTranslations("admUi.errors");
  return (code: string | undefined) => {
    if (!code) return "";
    if (code.startsWith("{")) return t("list");
    return t.has(code) ? t(code) : code;
  };
}

function FieldView({ field, error }: { field: FormField; error?: string }) {
  const errText = useErrorText();
  if (field.kind === "hidden") return <input type="hidden" name={field.name} value={field.value} />;
  const err = error ? <p className="mt-1.5 text-theme-xs text-error-500">{errText(error)}</p> : null;
  const hint = "hint" in field && field.hint ? <p className="mt-1.5 text-theme-xs text-gray-500 dark:text-gray-400">{field.hint}</p> : null;
  const wrap = (children: React.ReactNode, label = true) => (
    <div className={cn(field.wide && "md:col-span-2")}>
      {label && <Label htmlFor={`f-${field.name}`}>{field.label}</Label>}
      {children}
      {hint}
      {err}
    </div>
  );
  switch (field.kind) {
    case "info":
      return wrap(<p className="text-sm text-gray-700 dark:text-gray-300">{field.text}</p>);
    case "text":
    case "email":
    case "password":
    case "number":
    case "url":
    case "date":
    case "time":
      return wrap(
        <Input
          id={`f-${field.name}`}
          type={field.kind}
          name={field.name}
          defaultValue={field.value ?? ""}
          placeholder={field.placeholder}
          error={!!error}
          autoComplete={field.kind === "password" ? "new-password" : undefined}
        />,
      );
    case "textarea":
      return wrap(<textarea id={`f-${field.name}`} name={field.name} rows={field.rows ?? 4} defaultValue={field.value ?? ""} className={control} />);
    case "select":
      return wrap(
        <select id={`f-${field.name}`} name={field.name} defaultValue={field.value ?? ""} className={cn(control, "h-11 py-0")}>
          {field.options.map((o) => (
            <option key={o.value} value={o.value} className="dark:bg-gray-900">
              {o.label}
            </option>
          ))}
        </select>,
      );
    case "radio":
      return wrap(
        <div className="flex flex-wrap gap-4">
          {field.options.map((o) => (
            <label key={o.value} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
              <input type="radio" name={field.name} value={o.value} defaultChecked={field.value === o.value} className="accent-brand-500" />
              {o.label}
            </label>
          ))}
        </div>,
      );
    case "checkbox":
      return wrap(
        <label className="flex items-center gap-3 text-sm text-gray-700 dark:text-gray-300">
          <input type="checkbox" name={field.name} value={field.value ?? "on"} defaultChecked={!!field.checked} className="h-4 w-4 accent-brand-500" />
          {field.label}
        </label>,
        false,
      );
    case "checkboxes": {
      const groups = field.groups ?? [{ title: "", options: field.options }];
      return wrap(
        <div className="space-y-3">
          {groups.map((g) => (
            <div key={g.title}>
              {g.title && <p className="mb-1 text-theme-xs font-medium text-gray-500 uppercase dark:text-gray-400">{g.title}</p>}
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {g.options.map((o) => (
                  <label key={o.value} className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
                    <input type="checkbox" name={field.name} value={o.value} defaultChecked={field.values.includes(o.value)} className="mt-0.5 h-4 w-4 accent-brand-500" />
                    {o.label}
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>,
      );
    }
    case "access":
      return wrap(<AccessEditor field={field} />);
  }
}

/**
 * Form generico dell'area admin: sezioni in ComponentCard, invio con una server action
 * (useActionState) che restituisce gli errori per campo con i codici del dominio.
 */
export default function AdminForm({
  sections,
  action,
  submitLabel,
  savedMessage,
}: {
  sections: FormSection[];
  action: (prev: AdminFormState, form: FormData) => Promise<AdminFormState>;
  submitLabel?: string;
  savedMessage?: string;
}) {
  const t = useTranslations("admUi");
  const errText = useErrorText();
  const [state, formAction, pending] = useActionState(action, IDLE);
  const errors = state.errors ?? {};
  const known = new Set(sections.flatMap((s) => s.fields.map((f) => f.name.replace(/\[\]$/, ""))));
  const other = Object.entries(errors).filter(([k]) => !known.has(k));
  return (
    <form action={formAction} className="space-y-6" key={state.status === "saved" ? state.nonce : undefined}>
      {state.status === "saved" && (
        <div className="rounded-lg border border-success-500 bg-success-50 p-4 text-sm text-success-700 dark:border-success-500/30 dark:bg-success-500/15 dark:text-success-400">
          {savedMessage ?? t("saved")}
        </div>
      )}
      {state.status === "error" && (
        <div className="rounded-lg border border-error-500 bg-error-50 p-4 text-sm text-error-700 dark:border-error-500/30 dark:bg-error-500/15 dark:text-error-400">
          <p>{t("fixErrors")}</p>
          {other.length > 0 && (
            <ul className="mt-2 list-disc ps-5">
              {other.map(([k, v]) => (
                <li key={k}>{errText(v)}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {sections.map((s) => (
        <ComponentCard key={s.title} title={s.title} desc={s.desc}>
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
            {s.fields.map((f) => (
              <FieldView key={`${f.kind}-${f.name}`} field={f} error={errors[f.name.replace(/\[\]$/, "")]} />
            ))}
          </div>
        </ComponentCard>
      ))}
      <div className="flex justify-end">
        <Button type="submit" disabled={pending}>
          {pending ? t("saving") : (submitLabel ?? t("save"))}
        </Button>
      </div>
    </form>
  );
}
