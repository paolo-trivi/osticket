"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { InfoIcon } from "@/icons";

interface BoardNoticesProps {
  dragEnabled: boolean;
  total: number;
  /** almeno una card può cambiare stato */
  anyMovable: boolean;
}

function InfoLine({ children }: { children: ReactNode }) {
  return (
    <p className="mb-3 flex items-start gap-2 text-theme-sm text-gray-500 dark:text-gray-400">
      <InfoIcon
        viewBox="0 0 24 24"
        className="mt-0.5 size-4 shrink-0"
        aria-hidden
      />
      {children}
    </p>
  );
}

/** Avvisi sopra la board: trascinamento non disponibile, sola lettura, nessun ticket. */
export default function BoardNotices({ dragEnabled, total, anyMovable }: BoardNoticesProps) {
  const t = useTranslations("board");
  return (
    <>
      {!dragEnabled && <InfoLine>{t("drag.disabledGroup")}</InfoLine>}
      {dragEnabled && total > 0 && !anyMovable && (
        <InfoLine>{t("state.readOnly")}</InfoLine>
      )}
      {total === 0 && (
        <p className="mb-3 rounded-xl border border-dashed border-gray-300 px-4 py-6 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
          {t("state.empty")}
        </p>
      )}
    </>
  );
}
