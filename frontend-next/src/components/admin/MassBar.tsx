"use client";

import { useTranslations } from "next-intl";

/**
 * Pulsanti delle azioni di massa (mass_process di scp/*.php) dentro il <form> della lista: ogni
 * pulsante invia `a=<azione>` con gli `ids[]` selezionati; le azioni pericolose chiedono conferma.
 */
export default function MassBar({ actions }: { actions: { value: string; label: string; danger?: boolean }[] }) {
  const t = useTranslations("admUi");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="me-2 flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
        <SelectAll label={t("selectAll")} />
        {t("selectAll")}
      </label>
      <span className="text-sm text-gray-500 dark:text-gray-400">{t("selected")}</span>
      {actions.map((a) => (
        <button
          key={a.value}
          type="submit"
          name="a"
          value={a.value}
          onClick={(e) => {
            const form = e.currentTarget.form;
            if (form && !form.querySelector('input[name="ids[]"]:checked') && a.value !== "sort") {
              e.preventDefault();
              alert(t("selectFirst"));
              return;
            }
            if (a.danger && !confirm(t("confirm"))) e.preventDefault();
          }}
          className={
            a.danger
              ? "rounded-lg px-3 py-2 text-sm font-medium text-error-600 ring-1 ring-error-300 ring-inset hover:bg-error-50 dark:text-error-400 dark:ring-error-500/40 dark:hover:bg-error-500/10"
              : "rounded-lg px-3 py-2 text-sm font-medium text-gray-700 ring-1 ring-gray-300 ring-inset hover:bg-gray-50 dark:text-gray-300 dark:ring-gray-700 dark:hover:bg-white/5"
          }
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}

/** Casella "seleziona tutto" per gli ids[] del form. */
export function SelectAll({ label }: { label: string }) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      className="h-4 w-4 accent-brand-500"
      onChange={(e) => {
        const form = e.currentTarget.form;
        form?.querySelectorAll<HTMLInputElement>('input[name="ids[]"]').forEach((c) => (c.checked = e.currentTarget.checked));
      }}
    />
  );
}
