"use client";

import { useTranslations } from "next-intl";
import { useEffect } from "react";

import { CheckCircleIcon, CloseLineIcon, ErrorIcon, InfoIcon } from "@/icons";
import { cn } from "@/utils";

export interface ToastMessage {
  id: number;
  kind: "success" | "error" | "info";
  title: string;
  message?: string;
}

/** Notifica in basso (annunciata agli screen reader): successo e info si chiudono da sole, gli errori no. */
export default function BoardToast({
  toast,
  onClose,
}: {
  toast: ToastMessage | null;
  onClose: () => void;
}) {
  const t = useTranslations("common");
  useEffect(() => {
    if (!toast || toast.kind === "error") return;
    const h = window.setTimeout(onClose, 4000);
    return () => window.clearTimeout(h);
  }, [toast, onClose]);

  return (
    <div
      aria-live="polite"
      role="status"
      className="pointer-events-none fixed inset-x-4 bottom-4 z-99999 flex justify-center sm:inset-x-auto sm:start-6"
    >
      {toast && (
        <div
          key={toast.id}
          className={cn(
            "pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl border bg-white p-4 shadow-theme-lg dark:bg-gray-dark",
            toast.kind === "error" &&
              "border-error-500/40 dark:border-error-500/30",
            toast.kind === "success" &&
              "border-success-500/40 dark:border-success-500/30",
            toast.kind === "info" && "border-gray-200 dark:border-gray-800",
          )}
        >
          <span
            className={cn(
              "mt-0.5 shrink-0",
              toast.kind === "error" && "text-error-500",
              toast.kind === "success" && "text-success-500",
              toast.kind === "info" && "text-blue-light-500",
            )}
          >
            {toast.kind === "error" ? (
              <ErrorIcon viewBox="0 0 24 24" className="size-5" aria-hidden />
            ) : toast.kind === "success" ? (
              <CheckCircleIcon
                viewBox="0 0 24 24"
                className="size-5"
                aria-hidden
              />
            ) : (
              <InfoIcon viewBox="0 0 24 24" className="size-5" aria-hidden />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-gray-800 dark:text-white/90">
              {toast.title}
            </p>
            {toast.message && (
              <p className="mt-0.5 text-theme-sm text-gray-600 dark:text-gray-400">
                {toast.message}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("close")}
            className="-me-1 -mt-1 flex size-7 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-white/5 dark:hover:text-gray-200"
          >
            <CloseLineIcon viewBox="0 0 17 16" className="size-4" aria-hidden />
          </button>
        </div>
      )}
    </div>
  );
}
