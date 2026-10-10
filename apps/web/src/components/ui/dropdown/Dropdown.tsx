"use client";

import { cn } from "@/utils";
import type React from "react";
import { useEffect, useLayoutEffect, useRef } from "react";

interface DropdownProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
  /** "menu": le voci sono role="menuitem" (frecce, Home/Fine, Tab chiude); altrimenti pannello generico */
  role?: "menu";
  /** pulsante che apre il menu: riceve di nuovo il focus quando il menu si chiude con Esc */
  triggerRef?: React.RefObject<HTMLElement | null>;
  id?: string;
}

/** Margine minimo dai bordi della finestra (1rem, come il gutter delle pagine). */
const VIEWPORT_GAP = 16;

/** Lati entro cui deve restare il pannello. */
interface Bounds {
  left: number;
  right: number;
}

/** Quanto il rettangolo esce dai limiti (somma dei due lati, in px). */
function overflow(r: DOMRect, b: Bounds): number {
  return Math.max(0, b.left - r.left) + Math.max(0, r.right - b.right);
}

/**
 * Limiti del pannello: la finestra, ristretta al <main> che lo contiene (nel pannello agenti e admin la
 * sidebar fissa copre la parte di finestra a sinistra del contenuto), meno il margine dai bordi.
 */
function boundsOf(el: HTMLElement): Bounds {
  const vw = document.documentElement.clientWidth;
  const main = el.closest("main")?.getBoundingClientRect();
  return {
    left: Math.max(0, main?.left ?? 0) + VIEWPORT_GAP,
    right: Math.min(vw, main?.right ?? vw) - VIEWPORT_GAP,
  };
}

/**
 * Tiene il pannello dentro i limiti: di base è allineato alla fine del pulsante (inset-e-0); se esce prova
 * l'allineamento all'inizio e, se serve ancora, lo sposta del minimo necessario. Si misura il rettangolo
 * reale, quindi vale sia in LTR sia in RTL.
 */
function fitToBounds(el: HTMLElement): void {
  el.style.insetInlineStart = "";
  el.style.insetInlineEnd = "";
  el.style.translate = "";
  const bounds = boundsOf(el);
  let rect = el.getBoundingClientRect();
  if (overflow(rect, bounds) === 0) return;
  el.style.insetInlineStart = "0";
  el.style.insetInlineEnd = "auto";
  const flipped = el.getBoundingClientRect();
  if (overflow(flipped, bounds) < overflow(rect, bounds)) {
    rect = flipped;
  } else {
    el.style.insetInlineStart = "";
    el.style.insetInlineEnd = "";
  }
  const dx = rect.left < bounds.left ? bounds.left - rect.left : rect.right > bounds.right ? bounds.right - rect.right : 0;
  if (dx) el.style.translate = `${dx}px 0`;
}

const menuItems = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')];

export const Dropdown: React.FC<DropdownProps> = ({ isOpen, onClose, children, className = "", role, triggerRef, id }) => {
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        !(event.target as HTMLElement).closest(".dropdown-toggle")
      ) {
        onClose();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [onClose]);

  // Esc chiude e restituisce il focus al pulsante
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
      triggerRef?.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, onClose, triggerRef]);

  useLayoutEffect(() => {
    const el = dropdownRef.current;
    if (!isOpen || !el) return;
    const fit = () => fitToBounds(el);
    fit();
    if (role === "menu") menuItems(el)[0]?.focus();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [isOpen, role]);

  if (!isOpen) return null;

  // pattern "menu" (WAI-ARIA): frecce e Home/Fine spostano il focus tra le voci, Tab chiude il menu
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (role !== "menu") return;
    if (event.key === "Tab") {
      onClose();
      return;
    }
    const items = menuItems(event.currentTarget);
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "ArrowDown" ? (at + 1) % items.length
      : event.key === "ArrowUp" ? (at - 1 + items.length) % items.length
      : event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
      : -1;
    if (next < 0) return;
    event.preventDefault();
    items[next].focus();
  };

  return (
    <div
      ref={dropdownRef}
      id={id}
      role={role}
      onKeyDown={onKeyDown}
      className={cn(
        "absolute inset-e-0 z-40 mbs-2 max-w-[calc(100vw-2rem)] rounded-xl border border-gray-200 bg-white shadow-theme-lg dark:border-gray-800 dark:bg-gray-dark",
        className,
      )}
    >
      {children}
    </div>
  );
};
