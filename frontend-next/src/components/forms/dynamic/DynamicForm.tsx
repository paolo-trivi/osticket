"use client";

import type { ReactNode } from "react";

import { useTranslations } from "next-intl";

import type { DynamicFieldView, DynamicFormView } from "@/lib/forms/dynamic-field";

import DynamicField from "./DynamicField";

interface Props {
  form: DynamicFormView;
  /** valori inviati in precedenza per chiave `f.<id>` */
  values?: Record<string, string[]>;
  /** codici d'errore per id del campo (required, email, …) */
  errors?: Record<number, string[]>;
  /** campi da non mostrare (es. disattivati dal topic o gestiti altrove) */
  hidden?: number[];
  /** mostra titolo e istruzioni del form */
  showTitle?: boolean;
  /** rendering personalizzato del corpo del messaggio (campo "thread") */
  renderThread?: (field: DynamicFieldView) => ReactNode;
}

/** Form dinamico di osTicket (DynamicForm::render) con i renderer per tipo di campo. */
export default function DynamicForm({ form, values, errors, hidden, showTitle, renderThread }: Props) {
  const t = useTranslations("dynamicForms");
  const message = (code: string) => (t.has(`errors.${code}`) ? t(`errors.${code}`) : code);
  return (
    <div className="space-y-5">
      {showTitle && (
        <div>
          <h4 className="text-sm font-semibold text-gray-800 dark:text-white/90">{form.title}</h4>
          {form.instructions && <p className="text-theme-xs text-gray-500 dark:text-gray-400">{form.instructions}</p>}
        </div>
      )}
      {form.fields
        .filter((f) => !hidden?.includes(f.id))
        .map((f) =>
          f.kind === "thread" ? (
            <div key={f.id}>{renderThread?.(f)}</div>
          ) : (
            <DynamicField key={f.id} field={f} value={values?.[f.key]} errors={errors?.[f.id]?.map(message)} />
          ),
        )}
    </div>
  );
}
