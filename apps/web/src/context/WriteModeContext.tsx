"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

import { modeAllows, readOnlyReasons, type ReadOnlyReason, type WriteMode, type WriteScope } from "@/lib/write-mode";

interface WriteModeState {
  mode: WriteMode;
  canWrite: (scope: WriteScope) => boolean;
  /** motivi della sola lettura automatica (vuoto se la modalità è quella configurata) */
  reasons: ReadOnlyReason[];
}

/** Senza provider (pagine fuori dai layout che lo impostano) tutto resta scrivibile, come prima. */
const FULL: WriteModeState = {
  mode: "full",
  canWrite: () => true,
  reasons: [],
};

const WriteModeContext = createContext<WriteModeState>(FULL);

/** Modalità di scrittura effettiva, calcolata dal layout lato server (effectiveWriteMode). */
export function WriteModeProvider({ configured, effective, reasons, children }: { configured: WriteMode; effective: WriteMode; reasons: string[]; children: ReactNode }) {
  const key = reasons.join("|");
  const value = useMemo<WriteModeState>(
    () =>
      effective === "full"
        ? FULL
        : {
            mode: effective,
            canWrite: (scope) => modeAllows(effective, scope),
            reasons: readOnlyReasons(configured, effective, key ? key.split("|") : []),
          },
    [configured, effective, key],
  );
  return <WriteModeContext.Provider value={value}>{children}</WriteModeContext.Provider>;
}

export function useWriteMode(): WriteModeState {
  return useContext(WriteModeContext);
}
