"use client";

import flatpickr from "flatpickr";
import "flatpickr/dist/flatpickr.css";
import { Italian } from "flatpickr/dist/l10n/it";
import { useEffect } from "react";
import { Calendar } from "lucide-react";
import Label from "./Label";
import Hook = flatpickr.Options.Hook;
import DateOption = flatpickr.Options.DateOption;

/** Lingue del calendario (flatpickr usa l'inglese come predefinito). */
const LOCALES: Record<string, flatpickr.CustomLocale> = { it: Italian };
/** Formato mostrato all'utente per lingua; nel campo del form resta sempre Y-m-d. */
const DISPLAY_FORMATS: Record<string, string> = { it: "d/m/Y", en: "M j, Y" };

type PropsType = {
  id: string;
  mode?: "single" | "multiple" | "range" | "time";
  onChange?: Hook | Hook[];
  defaultDate?: DateOption;
  label?: string;
  placeholder?: string;
  /** nome del campo inviato col form (valore Y-m-d) */
  name?: string;
  /** lingua del calendario e del formato mostrato (it, en); senza, calendario inglese e formato Y-m-d */
  locale?: string;
};

export default function DatePicker({
  id,
  mode,
  onChange,
  label,
  defaultDate,
  placeholder,
  name,
  locale,
}: PropsType) {
  useEffect(() => {
    const lang = locale?.slice(0, 2);
    const flatPickr = flatpickr(`#${id}`, {
      mode: mode || "single",
      static: true,
      monthSelectorType: "static",
      dateFormat: "Y-m-d",
      defaultDate,
      onChange,
      // Calendario e formato nella lingua dell'interfaccia (il campo nativo segue invece la lingua del browser)
      ...(lang ? { locale: LOCALES[lang] ?? "default", altInput: true, altFormat: DISPLAY_FORMATS[lang] ?? "Y-m-d", disableMobile: true } : {}),
    });

    return () => {
      if (!Array.isArray(flatPickr)) {
        flatPickr.destroy();
      }
    };
  }, [mode, onChange, id, defaultDate, locale]);

  return (
    <div>
      {label && <Label htmlFor={id}>{label}</Label>}

      <div className="relative">
        <input
          id={id}
          name={name}
          defaultValue={typeof defaultDate === "string" ? defaultDate : undefined}
          placeholder={placeholder}
          className="h-11 w-full appearance-none rounded-lg border border-gray-300 bg-transparent px-4 py-2.5 pe-11 text-sm text-gray-800 shadow-theme-xs placeholder:text-gray-400 focus:border-brand-300 focus:ring-3 focus:ring-brand-500/20 focus:outline-hidden dark:border-gray-700 dark:bg-gray-900 dark:text-white/90 dark:placeholder:text-white/30 dark:focus:border-brand-800"
        />

        <span className="inset-e-3 pointer-events-none absolute top-1/2 -translate-y-1/2 text-gray-500 dark:text-gray-400">
          <Calendar className="size-5" />
        </span>
      </div>
    </div>
  );
}
