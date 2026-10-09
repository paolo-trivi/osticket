"use client";

import { useTranslations } from "next-intl";

import { ChevronDownIcon } from "@/icons";
import type { BoardLane } from "@/server/domain/board/types";
import { cn } from "@/utils";

import { ColumnMark } from "./ColumnTitle";

/** Intestazione di una swimlane (comprimibile), fissa a inizio riga durante lo scorrimento orizzontale. */
export default function LaneHeader({
  lane,
  collapsed,
  onToggle,
  controls,
}: {
  lane: BoardLane;
  collapsed: boolean;
  onToggle: () => void;
  controls: string;
}) {
  const t = useTranslations("board");
  return (
    <div className="col-span-full pt-2">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-controls={controls}
        aria-label={`${lane.title} — ${collapsed ? t("column.expand") : t("column.collapse")}`}
        className="sticky start-0 inline-flex max-w-full items-center gap-2 rounded-lg px-2 py-1.5 text-start hover:bg-gray-100 focus-visible:ring-3 focus-visible:ring-brand-500/30 focus-visible:outline-hidden dark:hover:bg-white/5"
      >
        <ChevronDownIcon
          viewBox="0 0 20 20"
          className={cn(
            "size-4 shrink-0 text-gray-500 transition-transform",
            collapsed && "-rotate-90 rtl:rotate-90",
          )}
          aria-hidden
        />
        <ColumnMark column={lane} />
        <span className="truncate text-sm font-semibold text-gray-800 dark:text-white/90">
          {lane.title}
          {lane.isMe && (
            <span className="ms-1.5 font-normal text-gray-500 dark:text-gray-400">
              ({t("column.me")})
            </span>
          )}
        </span>
        <span className="shrink-0 text-theme-xs text-gray-500 dark:text-gray-400">
          {t("lanesHeader.count", { count: lane.total })}
        </span>
      </button>
    </div>
  );
}
