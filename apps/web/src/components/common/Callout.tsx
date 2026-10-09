import type { ReactNode } from "react";

import { cn } from "@/utils";

const TONES = {
  warning: "border-warning-500 bg-warning-50 text-warning-700 dark:border-warning-500/30 dark:bg-warning-500/15 dark:text-orange-400",
  info: "border-blue-light-500 bg-blue-light-50 text-blue-light-700 dark:border-blue-light-500/30 dark:bg-blue-light-500/15 dark:text-blue-light-400",
  error: "border-error-500 bg-error-50 text-error-700 dark:border-error-500/30 dark:bg-error-500/15 dark:text-error-400",
  success: "border-success-500 bg-success-50 text-success-700 dark:border-success-500/30 dark:bg-success-500/15 dark:text-success-400",
};

/** Riquadro di avviso o di esito di un'azione (stile alert TailAdmin) delle pagine di amministrazione. */
export default function Callout({ tone = "warning", role, children }: { tone?: keyof typeof TONES; role?: "status" | "alert"; children: ReactNode }) {
  return (
    <div role={role} className={cn("rounded-lg border p-4 text-sm", TONES[tone])}>
      {children}
    </div>
  );
}
