"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import type { FormField } from "@/lib/admin/form-schema";
import { cn } from "@/utils";

type AccessField = Extract<FormField, { kind: "access" }>;

const control =
  "h-9 rounded-lg border border-gray-300 bg-transparent px-3 text-sm text-gray-800 focus:border-brand-300 focus:outline-hidden dark:border-gray-700 dark:bg-gray-900 dark:text-white/90";

/**
 * Elenco di accessi (membri del reparto, accessi estesi dell'agente, team, membri del team): righe
 * con ruolo e avvisi facoltativi, inviate come `${ids}[]`, `${role}[id]`, `${alerts}[id]=1`.
 */
export default function AccessEditor({ field }: { field: AccessField }) {
  const t = useTranslations("admUi");
  const [rows, setRows] = useState(field.selected);
  const [pick, setPick] = useState("");
  const label = (id: string) => field.choices.find((c) => c.value === id)?.label ?? id;
  const available = field.choices.filter((c) => !rows.some((r) => r.id === c.value));
  const idsName = `${field.ids}[]`;
  return (
    <div className="space-y-3">
      {rows.length === 0 && <p className="text-sm text-gray-500 dark:text-gray-400">{t("noneSelected")}</p>}
      {rows.length > 0 && (
        <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
          {rows.map((r, i) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
              <input type="hidden" name={idsName} value={r.id} />
              <span className="min-w-40 flex-1 text-sm text-gray-800 dark:text-white/90">{label(r.id)}</span>
              {field.role && field.roles && (
                <select
                  name={`${field.role}[${r.id}]`}
                  value={r.role ?? ""}
                  onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))}
                  className={control}
                  aria-label={t("role")}
                >
                  <option value="">{t("selectRole")}</option>
                  {field.roles.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              )}
              {field.alerts && (
                <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                  <input
                    type="checkbox"
                    name={`${field.alerts}[${r.id}]`}
                    value="1"
                    checked={!!r.alerts}
                    onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, alerts: e.target.checked } : x)))}
                    className="h-4 w-4 accent-brand-500"
                  />
                  {t("alerts")}
                </label>
              )}
              <button
                type="button"
                onClick={() => setRows(rows.filter((_, j) => j !== i))}
                className="text-sm font-medium text-error-500 hover:text-error-600"
              >
                {t("remove")}
              </button>
            </li>
          ))}
        </ul>
      )}
      {available.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <select value={pick} onChange={(e) => setPick(e.target.value)} className={cn(control, "min-w-56")} aria-label={t("add")}>
            <option value="">{t("choose")}</option>
            {available.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!pick}
            onClick={() => {
              setRows([...rows, { id: pick, role: field.roles?.[0]?.value, alerts: true }]);
              setPick("");
            }}
            className="h-9 rounded-lg bg-brand-500 px-3 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
          >
            {t("add")}
          </button>
        </div>
      )}
    </div>
  );
}
