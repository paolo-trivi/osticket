"use client";

import { useTranslations } from "next-intl";

import type { BoardColumn } from "@/server/domain/board/types";
import { cn } from "@/utils";

import { ColumnMark } from "./ColumnTitle";

/** Intestazione di una colonna: indicatore, titolo, numero di ticket. */
export default function BoardColumnHeader({
  column,
  count,
  dimmed,
  isMeLabel,
}: {
  column: BoardColumn;
  count: number;
  /** colonna non ammessa per la card trascinata */
  dimmed?: boolean;
  isMeLabel?: boolean;
}) {
  const t = useTranslations("board.column");
  return (
    <div
      className={cn(
        "flex snap-start items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2.5 transition-opacity dark:border-gray-800 dark:bg-white/3",
        column.state === "closed" && "bg-gray-50 dark:bg-white/2",
        dimmed && "opacity-40",
      )}
    >
      <ColumnMark column={column} />
      <h2
        className="min-w-0 flex-1 truncate text-sm font-semibold text-gray-800 dark:text-white/90"
        title={column.title}
      >
        {column.title}
        {isMeLabel && column.isMe && (
          <span className="ms-1.5 text-theme-xs font-normal text-gray-500 dark:text-gray-400">
            ({t("me")})
          </span>
        )}
      </h2>
      <span
        className="rounded-full bg-gray-100 px-2 py-0.5 text-theme-xs font-medium text-gray-600 tabular-nums dark:bg-white/5 dark:text-gray-300"
        aria-label={t("count", { count })}
      >
        {count}
      </span>
    </div>
  );
}
