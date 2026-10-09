"use client";

import { useCallback, useState, type ReactNode } from "react";

import { Dropdown } from "@/components/ui/dropdown/Dropdown";
import { ChevronDownIcon } from "@/icons";
import { cn } from "@/utils";

import { menuButtonClass } from "./menu-classes";

/** Pulsante con menu a discesa (stile TailAdmin); `children` riceve la funzione che chiude il menu. */
export default function MenuButton({
  label,
  width = "w-56",
  children,
}: {
  label: string;
  /** larghezza del menu (classe Tailwind) */
  width?: "w-56" | "w-60" | "w-64";
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <div className="relative">
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} className={cn("dropdown-toggle", menuButtonClass)}>
        {label}
        <ChevronDownIcon className={cn("size-4 transition-transform", open && "rotate-180")} />
      </button>
      <Dropdown isOpen={open} onClose={close} className={cn(width, "p-2")}>
        {children(close)}
      </Dropdown>
    </div>
  );
}
