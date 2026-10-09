import { ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge con le dimensioni di testo del tema (globals.css: --text-theme-*, --text-title-*):
 * senza questa estensione "text-theme-sm" verrebbe scambiato per un colore e scartato accanto a
 * "text-gray-700".
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["theme-xs", "theme-sm", "theme-xl", "title-sm", "title-md", "title-lg", "title-xl", "title-2xl"] }],
    },
  },
});

/**
 * Combines and merges Tailwind CSS class names with conditional logic.
 * @example
 * cn("bg-white", isActive && "text-black", "px-4") → "bg-white text-black px-4"
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(...inputs));
}
