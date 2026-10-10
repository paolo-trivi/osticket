"use client";

import ComponentCard from "@/components/common/ComponentCard";
import Badge from "@/components/ui/badge/Badge";
import Button from "@/components/ui/button/Button";
import { useTranslations } from "next-intl";

/** Esempi di pulsanti, badge e scheda ticket con il tema in modifica (applicato alla pagina dal vivo). */
export default function PreviewCard() {
  const t = useTranslations("admin.theme");
  return (
    <ComponentCard title={t("preview")}>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button size="sm">{t("sample.primary")}</Button>
          <Button size="sm" variant="outline">
            {t("sample.secondary")}
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge color="primary">{t("sample.badge")}</Badge>
          <Badge color="success">{t("sample.open")}</Badge>
          <Badge color="warning">{t("sample.overdue")}</Badge>
        </div>
        <div className="rounded-xl border border-gray-200 p-4 dark:border-gray-800">
          <p className="text-sm font-medium text-gray-800 dark:text-white/90">#247301 · {t("sample.subject")}</p>
          <p className="mt-1 text-theme-xs text-gray-500 dark:text-gray-400">{t("sample.meta")}</p>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
            <div className="h-full w-2/3 rounded-full bg-brand-500" />
          </div>
        </div>
      </div>
    </ComponentCard>
  );
}
