import { useTranslations } from "next-intl";

import type { BoardPriority } from "@/server/domain/board/types";
import { cn } from "@/utils";

/** Colore della striscia laterale della card per urgenza (i colori di osTicket sono tinte di sfondo molto chiare). */
export function priorityStripe(
  priority: Pick<BoardPriority, "urgency"> | null,
): string {
  switch (priority?.urgency) {
    case 1:
      return "border-s-error-500 dark:border-s-error-500";
    case 2:
      return "border-s-orange-500 dark:border-s-orange-500";
    case 3:
      return "border-s-blue-light-500 dark:border-s-blue-light-500";
    case 4:
      return "border-s-success-500 dark:border-s-success-500";
    default:
      return "border-s-gray-300 dark:border-s-gray-700";
  }
}

/** Pallino del colore configurato in osTicket (ticket_priority.priority_color) + nome della priorità. */
export default function PriorityPill({
  priority,
  className,
}: {
  priority: BoardPriority | null;
  className?: string;
}) {
  const t = useTranslations("board.card");
  if (!priority) return null;
  return (
    <span
      title={t("priority", { name: priority.name })}
      className={`text-theme-xs ${cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 font-medium text-gray-700 dark:bg-white/5 dark:text-white/80",
        className,
      )}`}
    >
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full bg-gray-400 ring-1 ring-black/10 dark:ring-white/20"
        style={priority.color ? { backgroundColor: priority.color } : undefined}
      />
      {priority.name}
    </span>
  );
}
