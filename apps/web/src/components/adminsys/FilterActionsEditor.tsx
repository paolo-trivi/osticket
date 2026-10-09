"use client";

import { useState } from "react";

import { cn } from "@/utils";

import { controlClass, type Opt } from "./fields";

export interface ActionFieldDef {
  name: string;
  kind: "choice" | "text" | "html";
  label: string;
  options?: Opt[];
}

export interface ActionTypeDef {
  type: string;
  label: string;
  group: string;
  multi?: boolean;
  fields: ActionFieldDef[];
  /** testo descrittivo per le azioni senza configurazione */
  info?: string;
}

interface Row {
  key: string;
  /** "I<id>" per le azioni esistenti, "N<tipo>" per le nuove; "D<id>" dopo l'eliminazione */
  value: string;
  type: string;
  config: Record<string, string>;
}

/**
 * Azioni del filtro (include/staff/filter.inc.php): ogni riga invia `actions[]` (I<id>, N<tipo> o
 * D<id>) e i campi di configurazione con i nomi del form della TriggerAction (dept_id, priority…).
 */
export default function FilterActionsEditor({
  types,
  existing,
  labels,
}: {
  types: ActionTypeDef[];
  existing: { id: number; type: string; config: Record<string, string> }[];
  labels: { add: string; select: string; remove: string; empty: string; unchanged: string };
}) {
  const [rows, setRows] = useState<Row[]>(existing.map((a) => ({ key: `I${a.id}`, value: `I${a.id}`, type: a.type, config: a.config })));
  const [seq, setSeq] = useState(0);
  const byType = new Map(types.map((t) => [t.type, t]));
  const used = new Set(rows.filter((r) => !r.value.startsWith("D")).map((r) => r.type));
  const groups = [...new Set(types.map((t) => t.group))];

  return (
    <div className="space-y-3">
      {rows.filter((r) => !r.value.startsWith("D")).length === 0 && <p className="text-sm text-gray-500 dark:text-gray-400">{labels.empty}</p>}
      <ul className="space-y-3">
        {rows.map((r) => {
          const def = byType.get(r.type);
          const deleted = r.value.startsWith("D");
          return (
            <li key={r.key} className={cn("rounded-xl border border-gray-200 p-4 dark:border-gray-800", deleted && "hidden")}>
              <input type="hidden" name="actions[]" value={r.value} />
              <div className="mb-3 flex items-center justify-between gap-3">
                <span className="text-sm font-medium text-gray-800 dark:text-white/90">{def?.label ?? r.type}</span>
                <button
                  type="button"
                  onClick={() => setRows((xs) => (r.value.startsWith("I") ? xs.map((x) => (x.key === r.key ? { ...x, value: `D${r.value.slice(1)}` } : x)) : xs.filter((x) => x.key !== r.key)))}
                  className="rounded px-2 py-1 text-sm text-error-600 hover:bg-error-50 dark:text-error-400 dark:hover:bg-error-500/10"
                >
                  {labels.remove}
                </button>
              </div>
              {!deleted && def && def.fields.length === 0 && def.info && <p className="text-sm text-gray-600 dark:text-gray-400">{def.info}</p>}
              {!deleted && def && (
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  {def.fields.map((f) => (
                    <div key={f.name} className={cn(f.kind !== "choice" && "md:col-span-2")}>
                      <label className="mb-1 block text-theme-xs font-medium text-gray-500 dark:text-gray-400">{f.label}</label>
                      {f.kind === "choice" ? (
                        <select name={f.name} defaultValue={r.config[f.name] ?? ""} className={cn(controlClass, "h-10 py-0")}>
                          {(f.options ?? []).map((o) => (
                            <option key={o.value} value={o.value} className="dark:bg-gray-900">
                              {o.label}
                            </option>
                          ))}
                        </select>
                      ) : f.kind === "html" ? (
                        <textarea name={f.name} rows={5} defaultValue={r.config[f.name] ?? ""} className={controlClass} />
                      ) : (
                        <input name={f.name} defaultValue={r.config[f.name] ?? ""} className={cn(controlClass, "h-10")} />
                      )}
                    </div>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <select
        aria-label={labels.add}
        value=""
        onChange={(e) => {
          const type = e.target.value;
          if (!type) return;
          setRows((xs) => [...xs, { key: `N${seq}`, value: `N${type}`, type, config: {} }]);
          setSeq((s) => s + 1);
        }}
        className={cn(controlClass, "h-10 max-w-sm py-0")}
      >
        <option value="">{labels.select}</option>
        {groups.map((g) => (
          <optgroup key={g} label={g}>
            {types
              .filter((t) => t.group === g)
              .map((t) => (
                <option key={t.type} value={t.type} disabled={used.has(t.type) && !t.multi}>
                  {t.label}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}
