import { Users } from "lucide-react";
import type { BoardColumn } from "@/server/domain/board/types";
import { cn } from "@/utils";

import { avatarTone } from "./AssigneeAvatar";

/** Indicatore della colonna/swimlane: pallino di stato o priorità, avatar dell'assegnatario. */
export function ColumnMark({ column }: { column: BoardColumn }) {
  if (column.assigneeKind) {
    const id = Number(column.key.slice(1)) || 0;
    return (
      <span
        aria-hidden
        className={cn(
          "inline-flex size-6 shrink-0 items-center justify-center text-[0.625rem] font-semibold",
          column.assigneeKind === "team" ? "rounded-md" : "rounded-full",
          avatarTone(column.assigneeKind, id),
        )}
      >
        {column.assigneeKind === "team" ? <Users className="size-3.5" /> : column.initials}
      </span>
    );
  }
  if (column.special === "unassigned") return <span aria-hidden className="inline-flex size-6 shrink-0 rounded-full border border-dashed border-gray-300 dark:border-gray-600" />;
  if (column.state) return <span aria-hidden className={cn("size-2.5 shrink-0 rounded-full", column.state === "closed" ? "bg-success-500" : "bg-blue-light-500")} />;
  if (column.color !== undefined)
    return (
      <span
        aria-hidden
        className="size-2.5 shrink-0 rounded-full bg-gray-400 ring-1 ring-black/10 dark:ring-white/20"
        style={column.color ? { backgroundColor: column.color } : undefined}
      />
    );
  return null;
}
