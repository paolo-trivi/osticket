"use client";

import { useTranslations } from "next-intl";

/** Casella "seleziona tutti" dell'intestazione della lista (righe con `data-mass-tid`). */
export default function MassSelectAll() {
  const t = useTranslations("ticketEdit.mass");
  return (
    <input
      type="checkbox"
      aria-label={t("selectAll")}
      className="size-4 accent-brand-500"
      onChange={(e) => {
        document.querySelectorAll<HTMLInputElement>("input[data-mass-tid]").forEach((i) => {
          i.checked = e.target.checked;
        });
      }}
    />
  );
}
