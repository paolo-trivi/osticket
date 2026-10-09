"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { Link } from "@/i18n/navigation";
import type { BoardColumn } from "@/server/domain/board/types";
import { cn } from "@/utils";

export type DropState = "idle" | "allowed" | "over" | "blocked" | "source";

/** Cella (colonna × swimlane): area di rilascio con le card, "carica altri" e la nota sui chiusi. */
export default function BoardCellView({
  cellKey,
  column,
  total,
  shown,
  olderClosed,
  dropState,
  blockedReason,
  loading,
  onLoadMore,
  olderHref,
  recentDays,
  sourceNoClosed,
  children,
}: {
  cellKey: string;
  column: BoardColumn;
  total: number;
  shown: number;
  olderClosed: number;
  dropState: DropState;
  blockedReason?: string;
  loading: boolean;
  onLoadMore: () => void;
  /** link "mostra anche i chiusi precedenti" (solo colonne di stati chiusi) */
  olderHref?: string;
  recentDays: number;
  sourceNoClosed: boolean;
  children: ReactNode;
}) {
  const t = useTranslations("board.column");
  const closed = column.state === "closed";
  const remaining = Math.max(0, total - shown);
  return (
    <div
      data-board-cell={cellKey}
      aria-label={column.title}
      className={cn(
        "relative flex min-h-28 flex-col gap-2 rounded-xl bg-gray-100/70 p-2 transition-[background-color,opacity,outline-color] dark:bg-white/2",
        "outline-2 outline-offset-0 outline-transparent",
        dropState === "allowed" &&
          "outline-brand-300 outline-dashed dark:outline-brand-700",
        dropState === "over" &&
          "bg-brand-50 outline-brand-500 outline-solid dark:bg-brand-500/10",
        dropState === "blocked" && "opacity-50",
      )}
    >
      {children}

      {shown === 0 && (
        <p className="flex flex-1 items-center justify-center py-6 text-center text-theme-xs text-gray-400 dark:text-gray-500">
          {dropState === "over" ? t("dropHere") : t("empty")}
        </p>
      )}

      {remaining > 0 && (
        <button
          type="button"
          onClick={onLoadMore}
          disabled={loading}
          className="rounded-lg px-3 py-2 text-theme-xs font-medium text-brand-600 hover:bg-white focus-visible:ring-3 focus-visible:ring-brand-500/30 focus-visible:outline-hidden disabled:opacity-60 dark:text-brand-400 dark:hover:bg-white/5"
        >
          {loading ? t("loadingMore") : t("loadMore", { remaining })}
        </button>
      )}

      {closed &&
        (sourceNoClosed || (olderHref !== undefined && olderClosed > 0)) && (
          <div className="mt-auto px-1 pt-1 text-theme-xs text-gray-500 dark:text-gray-400">
            {sourceNoClosed ? (
              <p>{t("sourceNoClosed")}</p>
            ) : olderHref !== undefined ? (
              <p>
                {t("recentOnly", { days: recentDays })} ·{" "}
                {t("olderHidden", { count: olderClosed })}{" "}
                <Link
                  href={olderHref}
                  className="font-medium text-brand-600 hover:underline dark:text-brand-400"
                >
                  {t("showOlder")}
                </Link>
              </p>
            ) : null}
          </div>
        )}

      {dropState === "blocked" && blockedReason && (
        <div className="pointer-events-none absolute inset-x-2 top-2 rounded-lg bg-gray-900/80 px-2 py-1 text-center text-theme-xs font-medium text-white dark:bg-black/70">
          {blockedReason}
        </div>
      )}
    </div>
  );
}
