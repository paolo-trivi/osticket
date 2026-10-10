"use client";

import { useTranslations } from "next-intl";

import { useWriteMode } from "@/context/WriteModeContext";
import { Info } from "lucide-react";
import { cn } from "@/utils";

/**
 * Fascia persistente della modalità di scrittura, sotto l'intestazione. Nulla se l'area è scrivibile
 * (modalità completa: interfaccia invariata). Agenti e admin: sola lettura con rimando al pannello
 * classico e, se scattata da sola, il motivo; admin in modalità operativa: amministrazione in sola
 * lettura. Portale: solo un messaggio per i clienti, senza dettagli tecnici.
 */
export default function WriteModeBanner({
  area,
  legacyUrl,
  className,
  innerClassName = "px-4 md:px-6",
}: {
  area: "agent" | "admin" | "portal";
  legacyUrl?: string;
  className?: string;
  /** allineamento del testo con il contenuto della pagina */
  innerClassName?: string;
}) {
  const t = useTranslations("writeMode");
  const { mode, canWrite, reasons } = useWriteMode();
  if (canWrite(area === "admin" ? "admin" : "operational")) return null;

  const portal = area === "portal";
  const text = portal ? t("banner.portal") : mode === "operational" ? t("banner.admin") : t("banner.readonly");
  const base = legacyUrl?.replace(/\/$/, "");
  const href = base ? `${base}/scp/${area === "admin" ? "admin.php" : ""}` : undefined;

  return (
    <div
      role="status"
      className={cn("border-b border-warning-200 bg-warning-50 text-theme-sm text-warning-700 dark:border-warning-500/30 dark:bg-warning-500/15 dark:text-orange-400", className)}
    >
      <div className={cn("flex items-start gap-2 py-2.5", innerClassName)}>
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="min-w-0">
          <p>
            {text}
            {!portal && href && (
              <>
                {" "}
                <a href={href} className="font-medium underline underline-offset-2 hover:text-warning-800 dark:hover:text-orange-300">
                  {t("banner.legacy")}
                </a>
              </>
            )}
          </p>
          {!portal && reasons.length > 0 && (
            <ul className="mt-0.5 text-theme-xs">
              {reasons.map((r) => (
                <li key={r}>{t("banner.reason", { reason: t(`reasons.${r}`) })}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
