"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { Info } from "lucide-react";

interface BoardNoticesProps {
  dragEnabled: boolean;
  /** sola lettura: nessuno spostamento possibile */
  readOnly?: boolean;
  total: number;
  /** almeno una card può cambiare stato */
  anyMovable: boolean;
}

function InfoLine({ children }: { children: ReactNode }) {
  return (
    <p className="mb-3 flex items-start gap-2 text-theme-sm text-gray-500 dark:text-gray-400">
      <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
      {children}
    </p>
  );
}

/** Avvisi sopra la board: trascinamento non disponibile, sola lettura, nessun ticket. */
export default function BoardNotices({ dragEnabled, readOnly = false, total, anyMovable }: BoardNoticesProps) {
  const t = useTranslations("board");
  const tw = useTranslations("writeMode");
  return (
    <>
      {readOnly && <InfoLine>{tw("boardDrag")}</InfoLine>}
      {!readOnly && !dragEnabled && <InfoLine>{t("drag.disabledGroup")}</InfoLine>}
      {!readOnly && dragEnabled && total > 0 && !anyMovable && <InfoLine>{t("state.readOnly")}</InfoLine>}
      {total === 0 && (
        <p className="mb-3 rounded-xl border border-dashed border-gray-300 px-4 py-6 text-center text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
          {t("state.empty")}
        </p>
      )}
    </>
  );
}
