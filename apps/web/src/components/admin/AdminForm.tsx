"use client";

import { useTranslations } from "next-intl";
import { useActionState, useEffect, useRef } from "react";

import Callout from "@/components/common/Callout";
import ComponentCard from "@/components/common/ComponentCard";
import { ReadOnlyNote, useReadOnlyHint } from "@/components/common/WriteGate";
import Label from "@/components/form/Label";
import Input from "@/components/form/input/InputField";
import Button from "@/components/ui/button/Button";
import { withCurrentOption } from "@/lib/admin/current-value";
import { IDLE, type AdminFormState, type FormField, type FormSection } from "@/lib/admin/form-schema";
import { cn } from "@/utils";

import { useUndoReload } from "./useUndoReload";

import AccessEditor from "./AccessEditor";
import UndoChange from "./UndoChange";
import { submitKeepingValues } from "@/lib/submit-keeping-values";

const control =
  "w-full rounded-lg border border-gray-300 bg-transparent px-4 py-2.5 text-sm text-gray-800 shadow-theme-xs focus:border-brand-300 focus:ring-3 focus:ring-brand-500/10 focus:outline-hidden dark:border-gray-700 dark:bg-gray-900 dark:text-white/90";
const legend = "mb-1.5 block text-sm font-medium text-gray-700 dark:text-gray-400";

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
  const id = `f-${field.name}`;
  const hasHint = "hint" in field && !!field.hint;
  // hint ed errore collegati al controllo (o al gruppo) con aria-describedby
  const describedBy = [hasHint && `${id}-hint`, error && `${id}-err`].filter(Boolean).join(" ") || undefined;
  const aria = {
    "aria-describedby": describedBy,
    "aria-invalid": error ? true : undefined,
  };
  const err = error ? (
    <p id={`${id}-err`} className="mt-1.5 text-theme-xs text-error-500">
      {errText(error)}
    </p>
  ) : null;
  const hint = hasHint ? (
    <p id={`${id}-hint`} className="mt-1.5 text-theme-xs text-gray-500 dark:text-gray-400">
      {field.hint}
    </p>
  ) : null;
  const wrap = (children: React.ReactNode, label = true) => (
    <div className={cn(field.wide && "md:col-span-2")}>
      {label && <Label htmlFor={id}>{field.label}</Label>}
      {children}
      {hint}
      {err}
    </div>
  );
  // gruppi di radio/checkbox: fieldset con legenda al posto di un'etichetta senza controllo
  const group = (children: React.ReactNode) => (
    <fieldset className={cn("min-w-0", field.wide && "md:col-span-2")} {...aria}>
      <legend className={legend}>{field.label}</legend>
      {children}
      {hint}
      {err}
    </fieldset>
  );
  switch (field.kind) {
    case "info":
      return (
        <div className={cn(field.wide && "md:col-span-2")}>
          <p className={legend}>{field.label}</p>
          <p className="text-sm text-gray-700 dark:text-gray-300">{field.text}</p>
        </div>
      );
    case "text":
    case "email":
    case "password":
    case "number":
    case "url":
    case "date":
    case "time":
      return wrap(
        <Input
          id={id}
          type={field.kind}
          name={field.name}
          defaultValue={field.value ?? ""}
          placeholder={field.placeholder}
          error={!!error}
          autoComplete={field.kind === "password" ? "new-password" : undefined}
          {...aria}
        />,
      );
    case "textarea":
      return wrap(<textarea id={id} name={field.name} rows={field.rows ?? 4} defaultValue={field.value ?? ""} className={cn(control, error && "border-error-500")} {...aria} />);
    case "select":
      return wrap(
        <select id={id} name={field.name} defaultValue={field.value ?? ""} className={cn(control, "h-11 py-0", error && "border-error-500")} {...aria}>
          {withCurrentOption(field.options, field.value, String).map((o) => (
            <option key={o.value} value={o.value} className="dark:bg-gray-900">
              {o.label}
            </option>
          ))}
        </select>,
      );
    case "radio":
      return group(
        <div className="flex flex-wrap gap-4">
          {withCurrentOption(field.options, field.value, String).map((o) => (
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
          <input type="checkbox" id={id} name={field.name} value={field.value ?? "on"} defaultChecked={!!field.checked} className="h-4 w-4 accent-brand-500" {...aria} />
          {field.label}
        </label>,
        false,
      );
    case "checkboxes": {
      const groups = field.groups ?? [{ title: "", options: field.options }];
      return group(
        <div className="space-y-3">
          {groups.map((g, i) => (
            <div key={g.title} role={g.title ? "group" : undefined} aria-labelledby={g.title ? `${id}-g${i}` : undefined}>
              {g.title && (
                <p id={`${id}-g${i}`} className="mb-1 text-theme-xs font-medium text-gray-500 uppercase dark:text-gray-400">
                  {g.title}
                </p>
              )}
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
      return (
        <div className={cn(field.wide && "md:col-span-2")} role="group" aria-labelledby={`${id}-label`} {...aria}>
          <p id={`${id}-label`} className={legend}>
            {field.label}
          </p>
          <AccessEditor field={field} />
          {hint}
          {err}
        </div>
      );
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
  // `saved`: nonce dell'ultimo salvataggio riuscito, chiave del form (resta uguale dopo un errore successivo)
  const [state, formAction, pending] = useActionState<AdminFormState & { saved?: number }, FormData>(async (prev, form) => {
    const r = await action(prev, form);
    return { ...r, saved: r.status === "saved" ? r.nonce : prev.saved };
  }, IDLE);
  const banner = useRef<HTMLDivElement>(null);
  // amministrazione non scrivibile (sola lettura o modalità operativa): salvataggio disattivato
  const readOnly = useReadOnlyHint("admin");
  const errors = state.errors ?? {};
  const known = new Set(sections.flatMap((s) => s.fields.map((f) => f.name.replace(/\[\]$/, ""))));
  const other = Object.entries(errors).filter(([k]) => !known.has(k));

  // il pulsante Salva è in fondo e l'esito in cima: dopo ogni invio il banner viene portato in vista
  useEffect(() => {
    if (state.status === "idle") return;
    banner.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    banner.current?.focus({ preventScroll: true });
  }, [state]);

  const submit = submitKeepingValues(formAction);
  const undo = useUndoReload();
  const undoneTxt = useTranslations("admChanges")("undone");

  return (
    <div className="space-y-6">
      <div ref={banner} tabIndex={-1} className="scroll-mt-24 outline-none empty:hidden">
        {state.status === "saved" && (
          <Callout tone="success" role="status">
            {undo.isUndone(state.nonce) ? undoneTxt : (savedMessage ?? t("saved"))}
            {state.change && !undo.isUndone(state.nonce) && <UndoChange key={state.nonce} change={state.change} inline onUndone={() => undo.reload(state.nonce)} />}
          </Callout>
        )}
        {state.status === "error" && (
          <Callout tone="error" role="alert">
            <p>{t("fixErrors")}</p>
            {other.length > 0 && (
              <ul className="mt-2 list-disc ps-5">
                {other.map(([k, v]) => (
                  <li key={k}>{errText(v)}</li>
                ))}
              </ul>
            )}
          </Callout>
        )}
      </div>
      {/* dopo un salvataggio riuscito il form si rimonta con i valori aggiornati dal server */}
      <form onSubmit={submit} className="space-y-6" key={`${state.saved ?? ""}-${undo.formKey}`}>
        <ReadOnlyNote scope="admin" />
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
          <Button type="submit" disabled={pending || !!readOnly} title={readOnly}>
            {pending ? t("saving") : (submitLabel ?? t("save"))}
          </Button>
        </div>
      </form>
    </div>
  );
}
