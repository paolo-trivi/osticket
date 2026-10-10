"use client";

import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef } from "react";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  className?: string;
  children: React.ReactNode;
  showCloseButton?: boolean; // New prop to control close button visibility
  isFullscreen?: boolean; // Default to false for backwards compatibility
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Elementi raggiungibili con Tab dentro il contenitore (visibili). */
function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
}

/**
 * Finestra di dialogo modale (role="dialog", aria-modal): il titolo è il primo heading del contenuto
 * (aria-labelledby), il focus va al primo campo del contenuto, Tab e Maiusc+Tab restano nella finestra,
 * Esc la chiude e alla chiusura il focus torna all'elemento che l'aveva aperta.
 */
export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  children,
  className,
  showCloseButton = true, // Default to true for backwards compatibility
  isFullscreen = false,
}) => {
  const t = useTranslations("common");
  const modalRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener("keydown", handleEscape);
    }

    return () => {
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen, onClose]);

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "unset";
    }

    return () => {
      document.body.style.overflow = "unset";
    };
  }, [isOpen]);

  // titolo accessibile, focus iniziale e ritorno del focus alla chiusura
  useEffect(() => {
    const dialog = modalRef.current;
    if (!isOpen || !dialog) return;
    const active = document.activeElement;
    const opener = active instanceof HTMLElement && !dialog.contains(active) ? active : null;
    const heading = bodyRef.current?.querySelector<HTMLElement>("h1, h2, h3, h4, h5, h6");
    if (heading) {
      if (!heading.id) heading.id = titleId;
      dialog.setAttribute("aria-labelledby", heading.id);
    }
    if (!dialog.contains(active)) {
      const first = bodyRef.current ? focusables(bodyRef.current)[0] : undefined;
      (first ?? dialog).focus();
    }
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, [isOpen, titleId]);

  if (!isOpen) return null;

  // trap semplice: Tab dall'ultimo elemento torna al primo e viceversa
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const items = focusables(event.currentTarget);
    if (!items.length) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !event.currentTarget.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !event.currentTarget.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  const contentClasses = isFullscreen
    ? "w-full h-full"
    : "relative w-full rounded-3xl bg-white  dark:bg-gray-900";

  return (
    <div className="modal fixed inset-0 z-99999 flex items-center justify-center overflow-y-auto">
      {!isFullscreen && <div className="fixed inset-0 h-full w-full bg-gray-400/50 backdrop-blur-[32px]" onClick={onClose}></div>}
      <div ref={modalRef} role="dialog" aria-modal="true" tabIndex={-1} className={`${contentClasses} ${className} outline-none`} onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        {showCloseButton && (
          <button
            type="button"
            onClick={onClose}
            aria-label={t("close")}
            title={t("close")}
            className="absolute inset-e-3 top-3 z-999 flex h-9.5 w-9.5 items-center justify-center rounded-full bg-gray-100 text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-700 sm:inset-e-6 sm:top-6 sm:h-11 sm:w-11 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-white"
          >
            <X className="size-5" />
          </button>
        )}
        <div ref={bodyRef}>{children}</div>
      </div>
    </div>
  );
};
