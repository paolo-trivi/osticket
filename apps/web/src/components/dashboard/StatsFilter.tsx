import { getLocale, getTranslations } from "next-intl/server";

import DatePicker from "@/components/form/date-picker";
import { ChevronDown } from "lucide-react";

interface StatsFilterProps {
  /** primo giorno del periodo (yyyy-mm-dd) */
  start: string;
  period: string;
  periods: readonly string[];
  group: string;
  /** "Dal … al … incluso (fuso …)" */
  rangeText: string;
}

/** Filtro del periodo della dashboard (data di inizio + durata) come il form di scp/dashboard.php; invio in GET. */
export default async function StatsFilter({ start, period, periods, group, rangeText }: StatsFilterProps) {
  const t = await getTranslations("dashboard");
  const ts = await getTranslations("stats");
  const locale = await getLocale();
  return (
    <div className="space-y-3">
      <form action="/agent" className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex w-full flex-col gap-1 xsm:w-48">
          <span className="text-gray-500 dark:text-gray-400">{t("from")}</span>
          <DatePicker id="stats-start" name="start" defaultDate={start} locale={locale} placeholder={ts("datePlaceholder")} />
        </label>
        <label className="flex w-full flex-col gap-1 xsm:w-48">
          <span className="text-gray-500 dark:text-gray-400">{t("period")}</span>
          <span className="relative">
            <select
              name="period"
              defaultValue={period}
              className="h-11 w-full appearance-none rounded-lg border border-gray-300 bg-transparent px-4 pe-11 text-sm text-gray-800 shadow-theme-xs focus:border-brand-300 focus:ring-3 focus:ring-brand-500/20 focus:outline-hidden dark:border-gray-700 dark:bg-gray-900 dark:text-white/90 dark:focus:border-brand-800"
            >
              {periods.map((p) => (
                <option key={p} value={p} className="dark:bg-gray-900">
                  {t(`periods.${p.replace(/[+ ]/g, "")}`)}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute end-4 top-1/2 size-5 -translate-y-1/2 text-gray-500 dark:text-gray-400" />
          </span>
        </label>
        <input type="hidden" name="group" value={group} />
        <button type="submit" className="h-11 rounded-lg bg-brand-500 px-4 font-medium text-white hover:bg-brand-600 dark:bg-brand-500 dark:hover:bg-brand-600">
          {t("refresh")}
        </button>
      </form>
      <p className="text-sm text-gray-600 dark:text-gray-400">{rangeText}</p>
    </div>
  );
}
