"use client";

import { Moon, Sun } from "lucide-react";
import { useTranslations } from "next-intl";
import React from "react";

import { useTheme } from "@/context/ThemeContext";

export const ThemeToggleButton: React.FC = () => {
  const { toggleTheme, allowUserMode } = useTheme();
  const t = useTranslations("header");
  if (!allowUserMode) return null;

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={t("toggleTheme")}
      title={t("toggleTheme")}
      className="hover:text-dark-900 relative flex h-11 w-11 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white"
    >
      <Sun className="hidden size-5 dark:block" />
      <Moon className="size-5 dark:hidden" />
    </button>
  );
};
