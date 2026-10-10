import type { ReactNode } from "react";

import { cn } from "@/utils";

const TONES = {
  success: "bg-success-50 text-success-700 dark:bg-success-500/15 dark:text-success-400",
  warning: "bg-warning-50 text-warning-700 dark:bg-warning-500/15 dark:text-orange-400",
};

/** Esito di un'azione mostrato sotto le barre azioni del ticket (ultima riga del flex), chiudibile dall'utente. */
export default function ActionNotice({ tone = "success", closeLabel, onClose, children }: { tone?: keyof typeof TONES; closeLabel: string; onClose: () => void; children: ReactNode }) {
  return (
    <div role="status" className={cn("order-last flex basis-full items-center justify-between gap-3 rounded-lg px-4 py-2 text-theme-sm", TONES[tone])}>
      <span>{children}</span>
      <button type="button" onClick={onClose} className="text-theme-xs underline">
        {closeLabel}
      </button>
    </div>
  );
}
