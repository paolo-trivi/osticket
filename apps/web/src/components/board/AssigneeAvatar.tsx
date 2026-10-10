import { useTranslations } from "next-intl";

import { Users } from "lucide-react";
import type { BoardAssignee } from "@/server/domain/board/types";
import { cn } from "@/utils";

const PALETTE = [
  "bg-brand-100 text-brand-700 dark:bg-brand-500/20 dark:text-brand-300",
  "bg-blue-light-100 text-blue-light-700 dark:bg-blue-light-500/20 dark:text-blue-light-300",
  "bg-success-100 text-success-700 dark:bg-success-500/20 dark:text-success-300",
  "bg-orange-100 text-orange-700 dark:bg-orange-500/20 dark:text-orange-300",
  "bg-theme-pink-500/15 text-theme-pink-500 dark:bg-theme-pink-500/25",
  "bg-theme-purple-500/15 text-theme-purple-500 dark:bg-theme-purple-500/25",
  "bg-warning-100 text-warning-700 dark:bg-warning-500/20 dark:text-warning-300",
];

/** Colore stabile per agente/team. */
export function avatarTone(kind: "staff" | "team", id: number): string {
  return PALETTE[(id * 7 + (kind === "team" ? 3 : 0)) % PALETTE.length];
}

/** Avatar con le iniziali dell'assegnatario (cerchio = agente, quadrato con icona = team, tratteggiato = nessuno). */
export default function AssigneeAvatar({ assignee, size = "sm", className }: { assignee: BoardAssignee | null; size?: "sm" | "md"; className?: string }) {
  const t = useTranslations("board.card");
  const dim = size === "sm" ? "size-7 text-[0.625rem]" : "size-8 text-theme-xs";
  if (!assignee)
    return (
      <span
        title={t("unassigned")}
        className={cn(
          "inline-flex shrink-0 rounded-full border border-dashed border-gray-300 dark:border-gray-600",
          dim,
          className,
        )}
      >
        <span className="sr-only">{t("unassigned")}</span>
      </span>
    );
  const label =
    assignee.kind === "team"
      ? t("team", { name: assignee.name })
      : t("assignee", { name: assignee.name });
  return (
    <span
      title={label}
      className={cn(
        "inline-flex shrink-0 items-center justify-center font-semibold",
        assignee.kind === "team" ? "rounded-lg" : "rounded-full",
        avatarTone(assignee.kind, assignee.id),
        dim,
        className,
      )}
    >
      {assignee.kind === "team" ? <Users className="size-4" aria-hidden /> : <span aria-hidden>{assignee.initials}</span>}
      <span className="sr-only">{label}</span>
    </span>
  );
}
