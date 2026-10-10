"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { ChevronDown, Search, X } from "lucide-react";
import { BOARD_GROUPS, BOARD_LANES, DEFAULT_BOARD_PARAMS, hasActiveFilters, type BoardGroupBy, type BoardLaneBy, type BoardParams } from "@/server/domain/board/params";
import type { BoardSourceOption } from "@/server/domain/board/types";
import { cn } from "@/utils";

export interface PriorityChoice {
  id: number;
  name: string;
  color: string | null;
}

function ToolbarSelect({ label, value, onChange, children, className }: { label: string; value: string; onChange: (v: string) => void; children: React.ReactNode; className?: string }) {
  return (
    <label className={cn("flex min-w-0 flex-col gap-1", className)}>
      <span className="text-theme-xs font-medium text-gray-500 dark:text-gray-400">
        {label}
      </span>
      <span className="relative">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-10 w-full appearance-none truncate rounded-lg border border-gray-300 bg-transparent ps-3 pe-9 text-sm text-gray-800 shadow-theme-xs focus:border-brand-300 focus:ring-3 focus:ring-brand-500/10 focus:outline-hidden dark:border-gray-700 dark:bg-gray-900 dark:text-white/90 dark:focus:border-brand-800"
        >
          {children}
        </select>
        <ChevronDown className="pointer-events-none absolute end-3 top-1/2 size-4 -translate-y-1/2 text-gray-500 dark:text-gray-400" aria-hidden />
      </span>
    </label>
  );
}

function Chip({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={`text-theme-sm ${cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 font-medium ring-1 transition focus-visible:ring-3 focus-visible:ring-brand-500/30 focus-visible:outline-hidden",
        pressed
          ? "bg-brand-500 text-white ring-brand-500 hover:bg-brand-600"
          : "bg-white text-gray-700 ring-gray-300 hover:bg-gray-50 dark:bg-white/3 dark:text-gray-300 dark:ring-gray-700 dark:hover:bg-white/5",
      )}`}
    >
      {children}
    </button>
  );
}

/** Barra della board: sorgente, ricerca, colonne, swimlane e filtri rapidi (tutto nei search params). */
export default function BoardToolbar({
  params,
  sources,
  priorities,
  onChange,
}: {
  params: BoardParams;
  sources: BoardSourceOption[];
  priorities: PriorityChoice[];
  /** campi cambiati (la board li applica sopra le scelte correnti, comprese quelle in attesa) */
  onChange: (patch: Partial<BoardParams>) => void;
}) {
  const t = useTranslations("board");
  const [q, setQ] = useState(params.q);
  const [lastQ, setLastQ] = useState(params.q);
  // la ricerca nell'URL cambia (es. "azzera filtri"): riallinea il campo
  if (params.q !== lastQ) {
    setLastQ(params.q);
    setQ(params.q);
  }
  const set = (patch: Partial<BoardParams>) => onChange(patch);
  const togglePrio = (id: number) =>
    set({
      prio: params.prio.includes(id)
        ? params.prio.filter((p) => p !== id)
        : [...params.prio, id].sort((a, b) => a - b),
    });

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <ToolbarSelect
          className="col-span-2 sm:col-span-1"
          label={t("toolbar.source")}
          value={String(params.source)}
          onChange={(v) => set({ source: v === "all" ? "all" : Number(v) })}
        >
          <option value="all">{t("toolbar.allVisible")}</option>
          {sources.length > 0 && (
            <optgroup label={t("toolbar.queues")}>
              {sources.map((s) => (
                <option key={s.value} value={s.value}>
                  {"  ".repeat(s.depth)}
                  {s.title}
                  {typeof s.count === "number" ? ` (${s.count})` : ""}
                </option>
              ))}
            </optgroup>
          )}
        </ToolbarSelect>

        <form
          role="search"
          className="col-span-2 flex min-w-0 flex-col gap-1 sm:col-span-1"
          onSubmit={(e) => {
            e.preventDefault();
            set({ q: q.trim() });
          }}
        >
          <label
            htmlFor="board-search"
            className="text-theme-xs font-medium text-gray-500 dark:text-gray-400"
          >
            {t("toolbar.search")}
          </label>
          <span className="relative">
            <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-gray-400" aria-hidden />
            <input
              id="board-search"
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("toolbar.searchPlaceholder")}
              enterKeyHint="search"
              className="h-10 w-full rounded-lg border border-gray-300 bg-transparent ps-9 pe-9 text-sm text-gray-800 shadow-theme-xs placeholder:text-gray-400 focus:border-brand-300 focus:ring-3 focus:ring-brand-500/10 focus:outline-hidden dark:border-gray-700 dark:bg-gray-900 dark:text-white/90 dark:placeholder:text-white/30 dark:focus:border-brand-800 [&::-webkit-search-cancel-button]:hidden"
            />
            {params.q && (
              <button
                type="button"
                onClick={() => {
                  setQ("");
                  set({ q: "" });
                }}
                aria-label={t("toolbar.clear")}
                className="absolute end-2 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-white/5 dark:hover:text-gray-200"
              >
                <X className="size-4" aria-hidden />
              </button>
            )}
          </span>
        </form>

        <ToolbarSelect
          label={t("toolbar.groupBy")}
          value={params.group}
          onChange={(v) => set({ group: v as BoardGroupBy })}
        >
          {BOARD_GROUPS.map((g) => (
            <option key={g} value={g}>
              {t(`group.${g}`)}
            </option>
          ))}
        </ToolbarSelect>

        <ToolbarSelect
          label={t("toolbar.swimlanes")}
          value={params.lane}
          onChange={(v) => set({ lane: v as BoardLaneBy })}
        >
          {BOARD_LANES.filter((l) => l !== params.group).map((l) => (
            <option key={l} value={l}>
              {t(`lane.${l}`)}
            </option>
          ))}
        </ToolbarSelect>
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-2" role="group" aria-label={t("toolbar.filters")}>
        <Chip pressed={params.mine} onClick={() => set({ mine: !params.mine, unassigned: false })}>
          {t("toolbar.mine")}
        </Chip>
        <Chip
          pressed={params.unassigned}
          onClick={() => set({ unassigned: !params.unassigned, mine: false })}
        >
          {t("toolbar.unassigned")}
        </Chip>
        <Chip
          pressed={params.overdue}
          onClick={() => set({ overdue: !params.overdue })}
        >
          {t("toolbar.overdue")}
        </Chip>
        <span
          className="mx-1 hidden h-5 w-px bg-gray-200 sm:inline-block dark:bg-gray-700"
          aria-hidden
        />
        {priorities.map((p) => (
          <Chip
            key={p.id}
            pressed={params.prio.includes(p.id)}
            onClick={() => togglePrio(p.id)}
          >
            <span
              aria-hidden
              className="size-2 rounded-full bg-gray-400 ring-1 ring-black/10 dark:ring-white/20"
              style={p.color ? { backgroundColor: p.color } : undefined}
            />
            <span className="sr-only">{t("toolbar.priority")}: </span>
            {p.name}
          </Chip>
        ))}
        {params.older && (
          <Chip pressed onClick={() => set({ older: false })}>
            {t("column.showRecentOnly")}
            <X className="size-3.5" aria-hidden />
          </Chip>
        )}
        {hasActiveFilters(params) && (
          <button
            type="button"
            onClick={() => {
              setQ("");
              // solo i filtri: sorgente, colonne, swimlane e "chiusi precedenti" restano
              onChange({
                mine: DEFAULT_BOARD_PARAMS.mine,
                unassigned: DEFAULT_BOARD_PARAMS.unassigned,
                overdue: DEFAULT_BOARD_PARAMS.overdue,
                prio: DEFAULT_BOARD_PARAMS.prio,
                q: DEFAULT_BOARD_PARAMS.q,
              });
            }}
            className="ms-1 shrink-0 text-theme-sm font-medium whitespace-nowrap text-brand-600 hover:underline dark:text-brand-400"
          >
            {t("toolbar.clear")}
          </button>
        )}
      </div>
    </div>
  );
}
