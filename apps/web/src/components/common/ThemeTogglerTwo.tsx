"use client";

import { Moon, Sun } from "lucide-react";
import { useTranslations } from "next-intl";

import { useTheme } from "@/context/ThemeContext";

export default function ThemeTogglerTwo() {
  const { toggleTheme, allowUserMode } = useTheme();
  const t = useTranslations("header");
  if (!allowUserMode) return null;
  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={t("toggleTheme")}
      title={t("toggleTheme")}
      className="inline-flex size-14 items-center justify-center rounded-full bg-brand-500 text-white transition-colors hover:bg-brand-600"
    >
      <Sun className="hidden size-5 dark:block" />
      <Moon className="size-5 dark:hidden" />
    </button>
  );
}
