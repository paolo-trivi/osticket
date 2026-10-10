"use client";

import type React from "react";
import { createContext, useContext, useEffect, useState } from "react";

type ThemeMode = "light" | "dark" | "auto";
type ResolvedTheme = "light" | "dark";

type ThemeContextType = {
  theme: ResolvedTheme; // Resolved theme actually active ("light" or "dark")
  themeMode: ThemeMode; // The configured preference ("light", "dark", or "auto")
  setThemeMode: (mode: ThemeMode) => void;
  toggleTheme: () => void;
  /** l'amministratore consente all'utente di scegliere chiaro/scuro */
  allowUserMode: boolean;
};

/** Chiaro/scuro effettivo di una modalità ("auto" segue il sistema operativo). Solo lato client. */
function resolveMode(mode: ThemeMode): ResolvedTheme {
  if (mode === "auto") return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  return mode;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

/** Chiave localStorage della preferenza utente (letta anche dallo script anti-flash del layout). */
export const THEME_STORAGE_KEY = "theme-mode";

export const ThemeProvider: React.FC<{
  children: React.ReactNode;
  /** modalità predefinita dal tema configurato in admin */
  defaultMode?: ThemeMode;
  allowUserMode?: boolean;
}> = ({ children, defaultMode = "light", allowUserMode = true }) => {
  const [themeMode, setThemeModeState] = useState<ThemeMode>(defaultMode);
  const [theme, setTheme] = useState<ResolvedTheme>("light");
  const [isInitialized, setIsInitialized] = useState(false);

  useEffect(() => {
    // This code will only run on the client side
    const savedMode = localStorage.getItem(THEME_STORAGE_KEY) as ThemeMode | null;
    const initialMode = (allowUserMode && savedMode) || defaultMode;

    // Lettura di localStorage possibile solo dopo il mount (niente mismatch di idratazione).
    // Il tema risolto si imposta insieme alla modalità: altrimenti il primo effetto che applica la classe
    // vedrebbe ancora "light" e toglierebbe per un istante il "dark" messo dallo script anti-flash del layout.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setThemeModeState(initialMode);
    setTheme(resolveMode(initialMode));
    setIsInitialized(true);
  }, [allowUserMode, defaultMode]);

  useEffect(() => {
    if (!isInitialized) return;

    if (allowUserMode) localStorage.setItem(THEME_STORAGE_KEY, themeMode);

    if (themeMode === "auto") {
      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

      const handleChange = () => {
        const resolved = mediaQuery.matches ? "dark" : "light";
        setTheme(resolved);
      };

      handleChange();

      mediaQuery.addEventListener("change", handleChange);
      return () => {
        mediaQuery.removeEventListener("change", handleChange);
      };
    } else {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTheme(themeMode as ResolvedTheme);
    }
  }, [themeMode, isInitialized, allowUserMode]);

  useEffect(() => {
    if (isInitialized) {
      if (theme === "dark") {
        document.documentElement.classList.add("dark");
        document.documentElement.setAttribute("data-color-scheme", "dark");
      } else {
        document.documentElement.classList.remove("dark");
        document.documentElement.setAttribute("data-color-scheme", "light");
      }
    }
  }, [theme, isInitialized]);

  const setThemeMode = (mode: ThemeMode) => {
    if (allowUserMode) setThemeModeState(mode);
  };

  const toggleTheme = () => {
    if (allowUserMode) setThemeModeState(theme === "light" ? "dark" : "light");
  };

  return <ThemeContext.Provider value={{ theme, themeMode, setThemeMode, toggleTheme, allowUserMode }}>{children}</ThemeContext.Provider>;
};

export const useTheme = () => {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
};
